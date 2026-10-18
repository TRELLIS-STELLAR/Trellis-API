export enum SupportAccessScope {
  READ_ONLY = "support:read-only",
  PORTFOLIO_READ = "support:portfolio-read",
  DEFI_READ = "support:defi-read",
  DIAGNOSTICS = "support:diagnostics",
  FULL = "support:full",
}

export const DEFAULT_IMPERSONATION_DURATION_MINUTES = 60;
export const MIN_IMPERSONATION_DURATION_MINUTES = 5;
export const MAX_IMPERSONATION_DURATION_MINUTES = 240; // 4 hours maximum

export interface ActiveSupportSession {
  sessionId: string;
  jti: string;
  targetUserId: string;
  adminId: string;
  scopes: SupportAccessScope[];
  reason: string;
  ticketId?: string;
  startedAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
}

export interface SupportSessionNotice {
  hasActiveSupportAccess: boolean;
  notice: string | null;
  session?: {
    scopes: SupportAccessScope[];
    startedAt: string;
    expiresAt: string;
    ticketId?: string | null;
  } | null;
}
