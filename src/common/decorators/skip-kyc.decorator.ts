import { SetMetadata } from "@nestjs/common";

export const SKIP_KYC_KEY = "skipKyc";
export const KYC_BYPASS_ACCESSED_EVENT = "KYC_BYPASS_ACCESSED";

/**
 * Marks a route/controller to bypass KYC checks.
 * Use only for onboarding flows that are required to become KYC verified.
 *
 * When detected by KycGuard, a structured audit event (KYC_BYPASS_ACCESSED)
 * is recorded to the SensitiveActionEvent table for regulatory compliance.
 */
export const SkipKyc = () => SetMetadata(SKIP_KYC_KEY, true);
