import {
  Controller,
  Get,
  Query,
  Headers,
  Param,
  HttpStatus,
  HttpCode,
} from "@nestjs/common";
import {
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiQuery,
  ApiParam,
  ApiHeader,
} from "@nestjs/swagger";
import {
  getAuthAccessibilitySuite,
  getPortfolioAccessibilitySuite,
  getDefiAccessibilitySuite,
  getNotificationsAccessibilitySuite,
  getObservabilityAccessibilitySuite,
  DomainAccessibilitySuite,
} from "./accessibility.suites";
import {
  AccessibilityWorkflowEnvelope,
  AccessibleTableContract,
  DenseFormAccessibilityContract,
  ErrorRecoveryAccessibilityContract,
} from "./accessibility.types";

export type AccessibleDomain = "auth" | "portfolio" | "defi" | "notifications" | "observability";

@ApiTags("Accessibility Contracts")
@Controller("api/v1/accessibility")
export class AccessibilityController {
  private getSuiteForDomain(
    domain: AccessibleDomain,
    reducedMotion?: string,
  ): DomainAccessibilitySuite {
    switch (domain) {
      case "auth":
        return getAuthAccessibilitySuite(reducedMotion);
      case "portfolio":
        return getPortfolioAccessibilitySuite(reducedMotion);
      case "defi":
        return getDefiAccessibilitySuite(reducedMotion);
      case "notifications":
        return getNotificationsAccessibilitySuite(reducedMotion);
      case "observability":
        return getObservabilityAccessibilitySuite(reducedMotion);
      default:
        return getAuthAccessibilitySuite(reducedMotion);
    }
  }

  @Get("suites/:domain")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Get full accessibility contract suite for a core domain workflow",
    description:
      "Returns accessibility contracts for dense forms, tables, error recovery, and workflow envelopes " +
      "including focus order, keyboard navigation, screen reader ARIA live announcements, and reduced motion settings.",
  })
  @ApiParam({
    name: "domain",
    enum: ["auth", "portfolio", "defi", "notifications", "observability"],
    description: "Core functional domain to inspect",
  })
  @ApiHeader({
    name: "sec-ch-prefers-reduced-motion",
    required: false,
    description: "Client reduced motion preference ('reduce' or 'no-preference')",
  })
  @ApiResponse({
    status: 200,
    description: "Domain accessibility contract suite returned successfully",
  })
  getDomainSuite(
    @Param("domain") domain: AccessibleDomain,
    @Headers("sec-ch-prefers-reduced-motion") reducedMotion?: string,
  ): DomainAccessibilitySuite {
    return this.getSuiteForDomain(domain, reducedMotion);
  }

  @Get("forms/:domain")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Get dense form accessibility metadata and focus order",
  })
  getDenseForm(
    @Param("domain") domain: AccessibleDomain,
  ): DenseFormAccessibilityContract {
    return this.getSuiteForDomain(domain).form;
  }

  @Get("tables/:domain")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Get accessible data table contract and grid navigation keys",
  })
  getTableContract(
    @Param("domain") domain: AccessibleDomain,
  ): AccessibleTableContract {
    return this.getSuiteForDomain(domain).table;
  }

  @Get("recovery/:domain")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Get error recovery accessibility guidance and rollback constraints",
  })
  getErrorRecovery(
    @Param("domain") domain: AccessibleDomain,
  ): ErrorRecoveryAccessibilityContract {
    return this.getSuiteForDomain(domain).errorRecovery;
  }

  @Get("workflow/:domain")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Get workflow focus management, keymap, and ARIA announcement envelope",
  })
  getWorkflowEnvelope(
    @Param("domain") domain: AccessibleDomain,
    @Headers("sec-ch-prefers-reduced-motion") reducedMotion?: string,
  ): AccessibilityWorkflowEnvelope {
    return this.getSuiteForDomain(domain, reducedMotion).workflow;
  }
}
