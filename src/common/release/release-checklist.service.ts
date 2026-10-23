import { Injectable, NotFoundException, BadRequestException } from "@nestjs/common";
import { logger } from "../../config/logger";
import {
  ReleaseChecklist,
  ReleaseCheck,
  CheckResult,
  CheckStatus,
  CheckSeverity,
  TRELLIS_API_RELEASE_CHECKS,
  isCriticalChange,
  calculateReleaseStatus,
} from "./release-checklist";
import {
  AutomatedVerificationPayload,
  ReleaseReadinessEvaluation,
  ReleaseAuditEntry,
  MigrationReadinessReport,
  SmokeTestReport,
  RollbackReadinessReport,
} from "./release-readiness.types";
import {
  verifyMigrationReadiness,
  executeSmokeTestsWithRetry,
  verifyRollbackSafety,
} from "./release-readiness.checker";

/**
 * Service for managing release readiness checklists.
 *
 * Provides:
 * - Checklist creation, storage, and retrieval
 * - Check status updates and validation
 * - Waiver management with audit trails
 * - Automated verification for migrations, smoke tests with retry, and rollback
 * - Approval gating for production releases
 */
@Injectable()
export class ReleaseChecklistService {
  private readonly checklists = new Map<string, ReleaseChecklist>();
  private readonly auditLogs = new Map<string, ReleaseAuditEntry[]>();

  /**
   * Create a new release checklist for a PR and register it in memory.
   */
  createChecklist(
    prNumber: string,
    title: string,
    files: string[],
    actor = "system",
  ): ReleaseChecklist {
    const isCritical = isCriticalChange(title, files);
    const checks = isCritical ? TRELLIS_API_RELEASE_CHECKS : this.getMinimalChecks();

    const checklist: ReleaseChecklist = {
      prNumber,
      title,
      isCriticalChange: isCritical,
      checks,
      results: new Map(),
      overallStatus: "NEEDS_ATTENTION",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Initialize all checks as NOT_STARTED
    for (const check of checks) {
      checklist.results.set(check.id, {
        checkId: check.id,
        status: CheckStatus.NOT_STARTED,
      });
    }

    this.checklists.set(prNumber, checklist);

    this.recordAudit(prNumber, {
      action: "CREATE",
      actor,
      timestamp: new Date(),
      details: `Created checklist for PR #${prNumber} (critical: ${isCritical}, ${checks.length} checks)`,
      newStatus: checklist.overallStatus,
    });

    logger.info(
      { prNumber, isCritical, checkCount: checks.length },
      "Release checklist created",
    );

    return checklist;
  }

  /**
   * Retrieve checklist by PR number.
   */
  getChecklist(prNumber: string): ReleaseChecklist | undefined {
    return this.checklists.get(prNumber);
  }

  /**
   * List all tracked release checklists.
   */
  listChecklists(): ReleaseChecklist[] {
    return Array.from(this.checklists.values());
  }

  /**
   * Get the minimal checklist for non-critical changes.
   */
  private getMinimalChecks(): ReleaseCheck[] {
    return TRELLIS_API_RELEASE_CHECKS.filter(
      (c) => c.severity === CheckSeverity.CRITICAL,
    );
  }

  /**
   * Update a check result directly on a checklist instance.
   */
  updateCheckResult(
    checklist: ReleaseChecklist,
    checkId: string,
    status: CheckStatus,
    options?: {
      failureReason?: string;
      evidenceUrl?: string;
      waiverReason?: string;
      waiverApprovedBy?: string;
      notes?: string;
      actor?: string;
    },
  ): void {
    let existingResult = checklist.results.get(checkId);
    if (!existingResult) {
      const standardCheck = TRELLIS_API_RELEASE_CHECKS.find((c) => c.id === checkId);
      if (standardCheck) {
        checklist.checks.push(standardCheck);
        existingResult = { checkId, status: CheckStatus.NOT_STARTED };
        checklist.results.set(checkId, existingResult);
      } else {
        logger.warn({ checkId }, "Check not found in checklist");
        return;
      }
    }

    const previousStatus = existingResult.status;

    const result: CheckResult = {
      checkId,
      status,
      passedAt: status === CheckStatus.PASSED ? new Date() : undefined,
      failureReason: options?.failureReason,
      evidenceUrl: options?.evidenceUrl,
      waiverReason: options?.waiverReason,
      waiverApprovedBy: options?.waiverApprovedBy,
      notes: options?.notes,
    };

    checklist.results.set(checkId, result);
    checklist.updatedAt = new Date();
    checklist.overallStatus = calculateReleaseStatus(checklist.results) as any;

    this.recordAudit(checklist.prNumber, {
      action: status === CheckStatus.WAIVED ? "WAIVE" : "CHECK_UPDATE",
      actor: options?.actor || options?.waiverApprovedBy || "system",
      timestamp: new Date(),
      details: `Check '${checkId}' changed from ${previousStatus} to ${status}${
        options?.failureReason ? `: ${options.failureReason}` : ""
      }${options?.waiverReason ? ` (waiver: ${options.waiverReason})` : ""}`,
      previousStatus,
      newStatus: status,
    });

    logger.info(
      { checkId, status, prNumber: checklist.prNumber },
      "Check result updated",
    );
  }

  /**
   * Update check result by PR number.
   */
  updateCheckByPr(
    prNumber: string,
    checkId: string,
    status: CheckStatus,
    options?: {
      failureReason?: string;
      evidenceUrl?: string;
      waiverReason?: string;
      waiverApprovedBy?: string;
      notes?: string;
      actor?: string;
    },
  ): ReleaseChecklist {
    const checklist = this.getChecklist(prNumber);
    if (!checklist) {
      throw new NotFoundException(`Release checklist for PR #${prNumber} not found`);
    }
    this.updateCheckResult(checklist, checkId, status, options);
    return checklist;
  }

  /**
   * Waive a check with required maintainer approval.
   */
  waiveCheck(
    checklist: ReleaseChecklist,
    checkId: string,
    reason: string,
    approvedBy: string,
  ): void {
    if (!reason || reason.trim().length < 10) {
      throw new BadRequestException("A detailed waiver reason (minimum 10 characters) is required.");
    }
    if (!approvedBy || approvedBy.trim() === "") {
      throw new BadRequestException("An approver identifier is required to waive checks.");
    }

    this.updateCheckResult(checklist, checkId, CheckStatus.WAIVED, {
      waiverReason: reason.trim(),
      waiverApprovedBy: approvedBy.trim(),
      actor: approvedBy.trim(),
    });

    logger.warn(
      { checkId, approvedBy, prNumber: checklist.prNumber },
      "Check waived",
    );
  }

  /**
   * Waive a check by PR number.
   */
  waiveCheckByPr(
    prNumber: string,
    checkId: string,
    reason: string,
    approvedBy: string,
  ): ReleaseChecklist {
    const checklist = this.getChecklist(prNumber);
    if (!checklist) {
      throw new NotFoundException(`Release checklist for PR #${prNumber} not found`);
    }
    this.waiveCheck(checklist, checkId, reason, approvedBy);
    return checklist;
  }

  /**
   * Mark a check as blocked pending external action.
   */
  blockCheck(
    checklist: ReleaseChecklist,
    checkId: string,
    reason: string,
  ): void {
    this.updateCheckResult(checklist, checkId, CheckStatus.BLOCKED, {
      failureReason: reason,
    });

    logger.warn(
      { checkId, reason, prNumber: checklist.prNumber },
      "Check blocked",
    );
  }

  /**
   * Get all checks that still need attention.
   */
  getPendingChecks(checklist: ReleaseChecklist): CheckResult[] {
    return Array.from(checklist.results.values()).filter(
      (r) =>
        r.status !== CheckStatus.PASSED &&
        r.status !== CheckStatus.WAIVED,
    );
  }

  /**
   * Get checklist readiness summary.
   */
  getReadinessSummary(checklist: ReleaseChecklist): {
    total: number;
    passed: number;
    failed: number;
    blocked: number;
    waived: number;
    notStarted: number;
    readinessPercent: number;
    overallStatus: "READY" | "NEEDS_ATTENTION" | "BLOCKED";
    blockingIssues: string[];
  } {
    const results = Array.from(checklist.results.values());
    const byStatus = {
      passed: results.filter((r) => r.status === CheckStatus.PASSED).length,
      failed: results.filter((r) => r.status === CheckStatus.FAILED).length,
      blocked: results.filter((r) => r.status === CheckStatus.BLOCKED).length,
      waived: results.filter((r) => r.status === CheckStatus.WAIVED).length,
      notStarted: results.filter((r) => r.status === CheckStatus.NOT_STARTED).length,
    };

    const blockingIssues = results
      .filter((r) => r.status === CheckStatus.BLOCKED || r.status === CheckStatus.FAILED)
      .map(
        (r) =>
          `${r.checkId}: ${r.failureReason || (r.status === CheckStatus.FAILED ? "Check failed" : "Blocked")}`,
      );

    const completedCount = byStatus.passed + byStatus.waived;
    const readinessPercent = results.length > 0 ? (completedCount / results.length) * 100 : 0;

    return {
      total: results.length,
      passed: byStatus.passed,
      failed: byStatus.failed,
      blocked: byStatus.blocked,
      waived: byStatus.waived,
      notStarted: byStatus.notStarted,
      readinessPercent: Math.round(readinessPercent),
      overallStatus: checklist.overallStatus,
      blockingIssues,
    };
  }

  /**
   * Approve a release (mark as ready for deployment).
   */
  approveRelease(
    checklist: ReleaseChecklist,
    approvedBy: string,
  ): boolean {
    const checkStatus = this.canApproveRelease(checklist);
    if (!checkStatus.canApprove) {
      logger.warn(
        { prNumber: checklist.prNumber, reason: checkStatus.reason },
        "Cannot approve release",
      );
      return false;
    }

    checklist.approvedBy = approvedBy;
    checklist.approvedAt = new Date();
    checklist.updatedAt = new Date();

    this.recordAudit(checklist.prNumber, {
      action: "APPROVE",
      actor: approvedBy,
      timestamp: new Date(),
      details: `Release approved for deployment by ${approvedBy}`,
      previousStatus: checklist.overallStatus,
      newStatus: "READY",
    });

    logger.info(
      { prNumber: checklist.prNumber, approvedBy },
      "Release approved",
    );

    return true;
  }

  /**
   * Approve release by PR number.
   */
  approveReleaseByPr(prNumber: string, approvedBy: string): { approved: boolean; reason?: string } {
    const checklist = this.getChecklist(prNumber);
    if (!checklist) {
      throw new NotFoundException(`Release checklist for PR #${prNumber} not found`);
    }

    const check = this.canApproveRelease(checklist);
    if (!check.canApprove) {
      return { approved: false, reason: check.reason };
    }

    const approved = this.approveRelease(checklist, approvedBy);
    return { approved, reason: approved ? undefined : "Approval failed" };
  }

  /**
   * Validate that all critical checks are completed before approval.
   */
  canApproveRelease(checklist: ReleaseChecklist): {
    canApprove: boolean;
    reason?: string;
  } {
    if (checklist.overallStatus === "BLOCKED") {
      return {
        canApprove: false,
        reason: "Critical checks are still blocked or failing",
      };
    }

    const criticalChecks = checklist.checks.filter(
      (c) => c.severity === CheckSeverity.CRITICAL,
    );

    for (const check of criticalChecks) {
      const result = checklist.results.get(check.id);
      if (!result || (result.status !== CheckStatus.PASSED && result.status !== CheckStatus.WAIVED)) {
        return {
          canApprove: false,
          reason: `Critical check not completed: ${check.name} (status: ${result?.status || "NOT_STARTED"})`,
        };
      }
    }

    return { canApprove: true };
  }

  /**
   * Execute automated verification for migrations, smoke tests with retry, and rollback.
   */
  async runAutomatedVerification(
    prNumber: string,
    payload: AutomatedVerificationPayload,
    actor = "system",
  ): Promise<ReleaseReadinessEvaluation> {
    let checklist = this.getChecklist(prNumber);
    if (!checklist) {
      // Auto-initialize if not yet created
      checklist = this.createChecklist(prNumber, `Automated PR #${prNumber}`, [], actor);
    }

    let migrationReport: MigrationReadinessReport | undefined;
    let smokeTestReport: SmokeTestReport | undefined;
    let rollbackReport: RollbackReadinessReport | undefined;
    const blockingReasons: string[] = [];

    // 1. Run migration checks if provided
    if (payload.migrations && payload.migrations.length > 0) {
      migrationReport = verifyMigrationReadiness(payload.migrations);

      if (migrationReport.isReady) {
        this.updateCheckResult(checklist, "migration_reversibility", CheckStatus.PASSED, {
          notes: `Verified ${migrationReport.checkedCount} migration(s): all reversible with valid down() methods.`,
          actor,
        });
        this.updateCheckResult(checklist, "migration_locking", CheckStatus.PASSED, {
          notes: `Verified ${migrationReport.lockingSafeCount} migration(s): no table locks or non-concurrent index additions.`,
          actor,
        });
      } else {
        const issuesSummary = migrationReport.issues.join("; ");
        blockingReasons.push(`Migration safety issues: ${issuesSummary}`);

        const hasReversibilityIssue = migrationReport.issues.some(
          (i) => i.includes("down()") || i.includes("irreversible"),
        );
        if (hasReversibilityIssue) {
          this.updateCheckResult(checklist, "migration_reversibility", CheckStatus.FAILED, {
            failureReason: issuesSummary,
            actor,
          });
        }

        const hasLockingIssue = migrationReport.issues.some((i) => i.includes("LOCK TABLE"));
        if (hasLockingIssue) {
          this.updateCheckResult(checklist, "migration_locking", CheckStatus.FAILED, {
            failureReason: issuesSummary,
            actor,
          });
        }
      }
    }

    // 2. Run smoke tests with retry if provided
    if (payload.smokeProbes && payload.smokeProbes.length > 0) {
      smokeTestReport = await executeSmokeTestsWithRetry(payload.smokeProbes, payload.options);

      if (smokeTestReport.allPassed) {
        this.updateCheckResult(checklist, "test_integration", CheckStatus.PASSED, {
          notes: `All ${smokeTestReport.passedProbes} smoke test probes passed (${smokeTestReport.totalDurationMs}ms total).`,
          actor,
        });
      } else {
        const failedDetails = smokeTestReport.results
          .filter((r) => r.status === "FAILED")
          .map((r) => `${r.name}: ${r.error || r.detail}`)
          .join("; ");
        blockingReasons.push(`Smoke tests failed: ${failedDetails}`);
        this.updateCheckResult(checklist, "test_integration", CheckStatus.FAILED, {
          failureReason: failedDetails,
          actor,
        });
      }
    }

    // 3. Run rollback safety checks if schema changes provided
    if (payload.schemaChanges && payload.schemaChanges.length > 0) {
      const downReversible = migrationReport ? migrationReport.reversibleCount === migrationReport.checkedCount : true;
      rollbackReport = verifyRollbackSafety(payload.schemaChanges, downReversible);

      if (rollbackReport.safeForZeroDowntimeRollback) {
        this.updateCheckResult(checklist, "rollback_data_safety", CheckStatus.PASSED, {
          notes: "Schema additions are backward-compatible (nullable / defaulted). Safe for rolling release rollback.",
          actor,
        });
        this.updateCheckResult(checklist, "rollback_procedure", CheckStatus.PASSED, {
          notes: "Rollback procedure and data safety verified.",
          actor,
        });
      } else {
        const breaking = rollbackReport.breakingChanges.join("; ");
        blockingReasons.push(`Rollback incompatibility: ${breaking}`);
        this.updateCheckResult(checklist, "rollback_data_safety", CheckStatus.FAILED, {
          failureReason: breaking,
          actor,
        });
      }
    }

    const overallReady = blockingReasons.length === 0 && checklist.overallStatus === "READY";

    this.recordAudit(prNumber, {
      action: "AUTOMATED_VERIFY",
      actor,
      timestamp: new Date(),
      details: `Automated release readiness verification executed (overall ready: ${overallReady})`,
      newStatus: checklist.overallStatus,
    });

    return {
      prNumber,
      overallReady,
      overallStatus: checklist.overallStatus,
      migrationReport,
      smokeTestReport,
      rollbackReport,
      evaluatedAt: new Date(),
      blockingReasons,
    };
  }

  /**
   * Retrieve audit history for a checklist.
   */
  getAuditHistory(prNumber: string): ReleaseAuditEntry[] {
    return this.auditLogs.get(prNumber) || [];
  }

  private recordAudit(prNumber: string, entry: ReleaseAuditEntry): void {
    if (!this.auditLogs.has(prNumber)) {
      this.auditLogs.set(prNumber, []);
    }
    this.auditLogs.get(prNumber)!.push(entry);
  }

  /**
   * Get automatable checks that haven't been run yet.
   */
  getAutomatableChecks(checklist: ReleaseChecklist): ReleaseCheck[] {
    return checklist.checks.filter(
      (c) =>
        c.automatable &&
        c.automationCommand &&
        checklist.results.get(c.id)?.status === CheckStatus.NOT_STARTED,
    );
  }

  /**
   * Format checklist for GitHub PR comment.
   */
  formatForPR(checklist: ReleaseChecklist): string {
    const summary = this.getReadinessSummary(checklist);
    const checks = Array.from(checklist.results.entries());

    const statusEmoji = {
      [CheckStatus.PASSED]: "✅",
      [CheckStatus.FAILED]: "❌",
      [CheckStatus.BLOCKED]: "🚫",
      [CheckStatus.WAIVED]: "⏭️",
      [CheckStatus.NOT_STARTED]: "⏳",
      [CheckStatus.IN_PROGRESS]: "🔄",
    };

    let markdown = `## Release Readiness Checklist\n\n`;
    markdown += `**Overall Status:** ${summary.overallStatus}\n`;
    markdown += `**Progress:** ${summary.passed}/${summary.total} checks passed (${summary.readinessPercent}%)\n\n`;

    // Group by category
    const byCategory = new Map<string, typeof checks>();
    for (const [checkId, result] of checks) {
      const check = checklist.checks.find((c) => c.id === checkId);
      if (check) {
        if (!byCategory.has(check.category)) {
          byCategory.set(check.category, []);
        }
        byCategory.get(check.category)!.push([checkId, result]);
      }
    }

    for (const [category, categoryChecks] of byCategory) {
      markdown += `### ${category.toUpperCase()}\n`;
      for (const [checkId, result] of categoryChecks) {
        const check = checklist.checks.find((c) => c.id === checkId);
        if (check) {
          markdown += `- ${statusEmoji[result.status]} **${check.name}** (${check.severity})\n`;
          if (result.failureReason) {
            markdown += `  - ❌ ${result.failureReason}\n`;
          }
          if (result.waiverReason) {
            markdown += `  - ⏭️ Waived: ${result.waiverReason} (by ${result.waiverApprovedBy})\n`;
          }
        }
      }
      markdown += "\n";
    }

    if (summary.blockingIssues.length > 0) {
      markdown += `### ⚠️ Blocking Issues\n`;
      for (const issue of summary.blockingIssues) {
        markdown += `- ${issue}\n`;
      }
      markdown += "\n";
    }

    markdown += `---\n`;
    markdown += `*Release checklist for #${checklist.prNumber}*\n`;

    return markdown;
  }
}
