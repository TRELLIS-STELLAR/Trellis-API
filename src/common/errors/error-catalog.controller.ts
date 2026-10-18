import { Controller, Get, Param, NotFoundException } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from "@nestjs/swagger";
import { Public } from "../decorators/public.decorator";
import { SkipKyc } from "../decorators/skip-kyc.decorator";
import { ErrorCode } from "./error-codes";
import { REMEDIATION_HINTS, RemediationHint } from "./remediation-hints";
import { ERROR_TAXONOMY, ErrorTaxonomyEntry } from "./error-taxonomy";

export interface ErrorCatalogItem {
  code: ErrorCode;
  domain: string;
  defaultMessage: string;
  recoveryGuidance: string;
  remediationHint: RemediationHint;
  retryable: boolean;
  retryStrategy: string;
}

@ApiTags("Error Taxonomy & Remediation")
@Controller("errors/catalog")
@Public()
@SkipKyc()
export class ErrorCatalogController {
  @Get()
  @ApiOperation({
    summary: "List all stable error codes with documented remediation hints",
    description: "Returns the authoritative machine-readable catalog of error codes, domains, and recovery steps.",
  })
  @ApiResponse({ status: 200, description: "Catalog of error codes" })
  getCatalog(): { total: number; catalog: ErrorCatalogItem[] } {
    const items: ErrorCatalogItem[] = Object.values(ErrorCode).map((code) => {
      const taxonomy: ErrorTaxonomyEntry | undefined = ERROR_TAXONOMY[code];
      const hint = REMEDIATION_HINTS[code];
      return {
        code,
        domain: taxonomy?.domain ?? "system",
        defaultMessage: taxonomy?.defaultMessage ?? code,
        recoveryGuidance: taxonomy?.recoveryGuidance ?? hint?.action ?? "Contact support",
        remediationHint: hint,
        retryable: hint?.retryable ?? false,
        retryStrategy: taxonomy?.retryStrategy ?? "none",
      };
    });

    return { total: items.length, catalog: items };
  }

  @Get(":code")
  @ApiOperation({ summary: "Get remediation hint for a specific error code" })
  @ApiParam({ name: "code", description: "Stable ErrorCode string (e.g. VALIDATION_ERROR)" })
  @ApiResponse({ status: 200, description: "Remediation hint for error code" })
  @ApiResponse({ status: 404, description: "Error code not found in catalog" })
  getErrorHint(@Param("code") code: string): ErrorCatalogItem {
    const errorCode = code.toUpperCase() as ErrorCode;
    const hint = REMEDIATION_HINTS[errorCode];
    if (!hint) {
      throw new NotFoundException(`Error code '${code}' not found in catalog.`);
    }

    const taxonomy = ERROR_TAXONOMY[errorCode];
    return {
      code: errorCode,
      domain: taxonomy?.domain ?? "system",
      defaultMessage: taxonomy?.defaultMessage ?? errorCode,
      recoveryGuidance: taxonomy?.recoveryGuidance ?? hint.action,
      remediationHint: hint,
      retryable: hint.retryable,
      retryStrategy: taxonomy?.retryStrategy ?? "none",
    };
  }
}
