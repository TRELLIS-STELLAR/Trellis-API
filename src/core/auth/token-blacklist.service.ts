import { Injectable, Logger, OnModuleDestroy, Optional } from "@nestjs/common";

/**
 * Redis-backed revocation store for jti replay prevention.
 *
 * Previously an in-process `Map`. That is correct for one process and wrong
 * for more than one: a jti revoked by one replica is invisible to another, so
 * a replayed access token passes on whichever instance happens to receive it.
 * The class comment already said "in production, replace with a Redis-backed
 * store"; this is that store.
 *
 * Redis is used when `REDIS_URL` is set and reachable. When it is not, the
 * service degrades to the in-process map rather than failing open — and says
 * so, loudly, because in that mode revocation is only honoured within this
 * process. Silently degrading is the failure mode that produced the original
 * bug, so the degradation is logged and observable via `isDistributed()`.
 *
 * Issue #144 (token revocation) and the original jti replay defence.
 *
 * Issue #369 adds a per-subject cutoff on top of per-jti revocation. A jti
 * list only covers tokens whose jti is known at revocation time; "log out
 * everywhere", a password change, or a refresh-token reuse detection must also
 * kill access tokens the server never enumerated. `revokeSubjectSessions`
 * records a cutoff, and any token whose `iat` is at or before it is stale.
 */

/** Longer than any access token lifetime, so a cutoff outlives every token it covers. */
export const SESSION_CUTOFF_TTL_SECONDS = 24 * 60 * 60;

/** The subset of the ioredis client this service uses. */
export interface RedisLikeClient {
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
  exists(key: string): Promise<number>;
  get?(key: string): Promise<string | null>;
  del?(key: string): Promise<number>;
  quit?(): Promise<unknown>;
  disconnect?(): void;
  on?(event: string, handler: (...args: any[]) => void): void;
}

@Injectable()
export class TokenBlacklistService implements OnModuleDestroy {
  private readonly logger = new Logger(TokenBlacklistService.name);
  private readonly local = new Map<string, number>(); // jti -> expiry epoch ms
  private readonly localCutoffs = new Map<
    string,
    { cutoff: number; expiresAt: number }
  >(); // subject -> cutoff (epoch seconds) and expiry epoch ms
  private readonly cleanupIntervalMs = 5 * 60 * 1000;
  private client: RedisLikeClient | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(@Optional() client?: RedisLikeClient | null) {
    this.client = client ?? null;
    this.timer = setInterval(() => this.cleanup(), this.cleanupIntervalMs);
    // Never hold the event loop open for a cleanup timer.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /** True when revocations are shared across processes. */
  isDistributed(): boolean {
    return this.client !== null;
  }

  /** Blacklist a jti until its expiry time. */
  async revoke(jti: string, expiresAt: number): Promise<void> {
    const ttlSeconds = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));

    if (this.client) {
      try {
        await this.client.set(this.key(jti), "1", "EX", ttlSeconds);
        return;
      } catch (error) {
        // A Redis outage must not silently turn into "not revoked". Fall back
        // to the local map for this entry and say so.
        this.logger.error(
          `Redis revoke failed for jti ${jti}; recording locally only: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    this.local.set(jti, expiresAt);
  }

  /** Returns true if the jti has been revoked. */
  async isRevoked(jti: string): Promise<boolean> {
    if (this.client) {
      try {
        return (await this.client.exists(this.key(jti))) > 0;
      } catch (error) {
        this.logger.error(
          `Redis lookup failed for jti ${jti}; falling back to local state: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const exp = this.local.get(jti);
    if (exp === undefined) return false;
    if (Date.now() > exp) {
      this.local.delete(jti);
      return false;
    }
    return true;
  }

  /**
   * Invalidate every session issued to `subject` at or before `cutoffSeconds`
   * (epoch seconds, defaults to now). A later call can only move the cutoff
   * forward, so a retried or out-of-order revocation never re-admits sessions.
   */
  async revokeSubjectSessions(
    subject: string,
    cutoffSeconds: number = Math.floor(Date.now() / 1000),
  ): Promise<void> {
    const existing = await this.getSubjectCutoff(subject);
    const cutoff = Math.max(cutoffSeconds, existing ?? 0);

    if (this.client?.get) {
      try {
        await this.client.set(
          this.subjectKey(subject),
          String(cutoff),
          "EX",
          SESSION_CUTOFF_TTL_SECONDS,
        );
        return;
      } catch (error) {
        this.logger.error(
          `Redis session cutoff failed for subject ${subject}; recording locally only: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    this.localCutoffs.set(subject, {
      cutoff,
      expiresAt: Date.now() + SESSION_CUTOFF_TTL_SECONDS * 1000,
    });
  }

  /**
   * True when the session was issued at or before the subject's cutoff. A token
   * without an `iat` cannot be placed relative to the cutoff, so it is stale
   * whenever a cutoff exists.
   */
  async isSessionStale(
    subject: string,
    issuedAtSeconds: number | undefined,
  ): Promise<boolean> {
    const cutoff = await this.getSubjectCutoff(subject);
    if (cutoff === null) return false;
    if (typeof issuedAtSeconds !== "number") return true;
    return issuedAtSeconds <= cutoff;
  }

  private async getSubjectCutoff(subject: string): Promise<number | null> {
    let cutoff: number | null = null;

    if (this.client?.get) {
      try {
        const raw = await this.client.get(this.subjectKey(subject));
        const parsed = raw === null ? NaN : Number(raw);
        if (Number.isFinite(parsed)) cutoff = parsed;
      } catch (error) {
        this.logger.error(
          `Redis cutoff lookup failed for subject ${subject}; falling back to local state: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const local = this.localCutoffs.get(subject);
    if (local) {
      if (Date.now() > local.expiresAt) {
        this.localCutoffs.delete(subject);
      } else if (cutoff === null || local.cutoff > cutoff) {
        cutoff = local.cutoff;
      }
    }

    return cutoff;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.client?.quit) {
      try {
        await this.client.quit();
      } catch {
        // Shutting down; a failed quit is not actionable.
      }
    }
    this.client?.disconnect?.();
  }

  private key(jti: string): string {
    return `token-blacklist:${jti}`;
  }

  private subjectKey(subject: string): string {
    return `token-cutoff:${subject}`;
  }

  /** Remove expired local entries to prevent unbounded memory growth. */
  private cleanup(): void {
    const now = Date.now();
    for (const [jti, exp] of this.local) {
      if (now > exp) this.local.delete(jti);
    }
    for (const [subject, entry] of this.localCutoffs) {
      if (now > entry.expiresAt) this.localCutoffs.delete(subject);
    }
  }
}
