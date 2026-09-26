import { SetMetadata } from "@nestjs/common";

export const ALLOW_IMPERSONATION_KEY = "allowImpersonation";
export const AllowImpersonation = () => SetMetadata(ALLOW_IMPERSONATION_KEY, true);
