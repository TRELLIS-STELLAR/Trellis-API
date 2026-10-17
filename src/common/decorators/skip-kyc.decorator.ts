import { SetMetadata } from "@nestjs/common";
import { SensitiveActionEventType } from "../enums/sensitive-action-event-type.enum";

export const SKIP_KYC_KEY = "skipKyc";

/**
 * Marks a route/controller to bypass KYC checks.
 * Use only for onboarding flows that are required to become KYC verified.
 *
 * When detected by KycGuard, a structured audit event
 * (KYC_BYPASS_ACCESSED) is recorded to the SensitiveActionEvent table.
 */
export const SkipKyc = () =>
  SetMetadata(SKIP_KYC_KEY, SensitiveActionEventType.KYC_BYPASS_ACCESSED);
