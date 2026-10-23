import { Injectable, Logger, Optional, Inject, OnModuleDestroy } from "@nestjs/common";
import * as crypto from "crypto";
import { CACHE_REDIS_CLIENT } from "src/common/cache/cache.constants";

export interface WsTicketData {
  userId: string;
  [key: string]: any;
}

interface MemoryTicketEntry {
  payload: string;
  expiresAt: number;
}

@Injectable()
export class WsTicketService implements OnModuleDestroy {
  private readonly logger = new Logger(WsTicketService.name);
  public static readonly TICKET_TTL_SECONDS = 30;
  public static readonly TICKET_PREFIX = "ws:ticket:";

  private readonly memoryStore = new Map<string, MemoryTicketEntry>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(
    @Optional() @Inject(CACHE_REDIS_CLIENT) private readonly redis?: any,
  ) {
    this.cleanupTimer = setInterval(() => this.cleanupExpiredTickets(), 10000);
    if (typeof this.cleanupTimer.unref === "function") {
      this.cleanupTimer.unref();
    }
  }

  onModuleDestroy() {
    clearInterval(this.cleanupTimer);
    this.memoryStore.clear();
  }

  /**
   * Issue a short-lived single-use WebSocket ticket (TTL: 30 seconds)
   */
  async createTicket(userId: string, metadata: Record<string, any> = {}): Promise<string> {
    const ticketId = `wst_${crypto.randomBytes(24).toString("hex")}`;
    const key = `${WsTicketService.TICKET_PREFIX}${ticketId}`;
    const payload = JSON.stringify({
      userId,
      ...metadata,
      createdAt: Date.now(),
    });

    // Store in Redis with 30-second TTL
    if (this.redis) {
      try {
        if (typeof this.redis.set === "function") {
          await this.redis.set(key, payload, "EX", WsTicketService.TICKET_TTL_SECONDS);
        } else if (typeof this.redis.setex === "function") {
          await this.redis.setex(key, WsTicketService.TICKET_TTL_SECONDS, payload);
        }
      } catch (error) {
        this.logger.warn({ error: error.message }, "Redis set ticket failed; using memory fallback");
      }
    }

    // Always store in memory fallback as well
    this.memoryStore.set(ticketId, {
      payload,
      expiresAt: Date.now() + WsTicketService.TICKET_TTL_SECONDS * 1000,
    });

    return ticketId;
  }

  /**
   * Validate and immediately invalidate single-use ticket in Redis / memory.
   * Returns ticket payload if valid, or null if expired / already consumed.
   */
  async validateAndConsumeTicket(ticket: string): Promise<WsTicketData | null> {
    if (!ticket || typeof ticket !== "string") {
      return null;
    }

    const key = `${WsTicketService.TICKET_PREFIX}${ticket}`;
    let rawPayload: string | null = null;

    if (this.redis) {
      try {
        const luaScript = `
          local val = redis.call('GET', KEYS[1])
          if val then
            redis.call('DEL', KEYS[1])
            return val
          else
            return nil
          end
        `;

        if (typeof this.redis.eval === "function") {
          rawPayload = await this.redis.eval(luaScript, 1, key);
        } else if (typeof this.redis.getdel === "function") {
          rawPayload = await this.redis.getdel(key);
        } else if (typeof this.redis.get === "function") {
          rawPayload = await this.redis.get(key);
          if (rawPayload && typeof this.redis.del === "function") {
            await this.redis.del(key);
          }
        }
      } catch (error) {
        this.logger.warn({ error: error.message }, "Redis ticket lookup failed; checking memory fallback");
      }
    }

    // Check memory store (either fallback or standalone)
    if (!rawPayload && this.memoryStore.has(ticket)) {
      const entry = this.memoryStore.get(ticket)!;
      this.memoryStore.delete(ticket);
      if (entry.expiresAt > Date.now()) {
        rawPayload = entry.payload;
      }
    } else if (this.memoryStore.has(ticket)) {
      // If found in Redis, also purge memory copy
      this.memoryStore.delete(ticket);
    }

    if (!rawPayload) {
      return null;
    }

    try {
      return JSON.parse(rawPayload);
    } catch {
      return { userId: rawPayload };
    }
  }

  private cleanupExpiredTickets() {
    const now = Date.now();
    for (const [ticket, entry] of this.memoryStore.entries()) {
      if (entry.expiresAt <= now) {
        this.memoryStore.delete(ticket);
      }
    }
  }
}
