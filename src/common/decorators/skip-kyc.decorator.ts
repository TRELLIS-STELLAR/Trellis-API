import { SetMetadata } from "@nestjs/common";

export const SKIP_KYC_KEY = "skipKyc";

/**
 * Marks a route/controller to bypass KYC checks.
 * Use only for onboarding flows that are required to become KYC verified.
 *
 * When detected by KycGuard, a structured kyc_bypass_accessed audit event is
 * emitted to the SensitiveActionEvent log for regulatory compliance tracking.
 */
export const SkipKyc = () => SetMetadata(SKIP_KYC_KEY, true);
