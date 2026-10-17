import { SetMetadata } from "@nestjs/common";

export const SKIP_KYC_KEY = "skipKyc";
export const KYC_BYPASS_ACCESSED_EVENT = "KYC_BYPASS_ACCESSED";
export const KYC_BYPASS_AUDIT_ACTION = "KYC_BYPASS_ACCESSED" as const;

/**
 * Marks a route/controller to bypass KYC checks.
 * Use only for onboarding flows that are required to become KYC verified.
 *
 * Accessing an endpoint decorated with this marker causes KycGuard to emit an
 * `KYC_BYPASS_ACCESSED` audit event to the `SensitiveActionEvent` log for
 * regulatory compliance tracking.
 */
export const SkipKyc = () => SetMetadata(SKIP_KYC_KEY, true);
