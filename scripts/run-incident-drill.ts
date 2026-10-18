/**
 * Incident Drill Verification CLI
 *
 * Executes deterministic incident drill scenarios verifying containment pauses,
 * signed snapshot integrity, rollback safety gates, cross-domain data invariant
 * validation, idempotent operation recovery, and redacted user-impact reporting.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/run-incident-drill.ts
 *   npm run incident:drill
 *   npm run incident:drill -- --json
 *   npm run incident:drill -- --scenario=SEV1_SETTLEMENT_AND_PORTFOLIO_DRIFT
 */

import { IncidentDrillService } from '../src/infrastructure/disaster-recovery/incident-drill.service';
import {
  DrillScenarioId,
  IncidentDrillScenarioReport,
} from '../src/infrastructure/disaster-recovery/incident-drill.types';

async function runIncidentDrillCli() {
  const isJson = process.argv.includes('--json');
  const scenarioArg = process.argv.find((arg) => arg.startsWith('--scenario='));
  const requestedScenario = scenarioArg?.split('=')[1] as
    | DrillScenarioId
    | undefined;

  const service = new IncidentDrillService();

  try {
    if (requestedScenario) {
      if (
        !Object.values(DrillScenarioId).includes(requestedScenario)
      ) {
        throw new Error(
          `Unknown scenario "${requestedScenario}". Valid scenarios: ${Object.values(DrillScenarioId).join(', ')}`,
        );
      }
      const report = await service.runScenario(requestedScenario);
      if (isJson) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printScenarioReport(report);
      }
      process.exit(report.passed ? 0 : 1);
    }

    const suiteReport = await service.runAllDrillScenarios();

    if (isJson) {
      console.log(JSON.stringify(suiteReport, null, 2));
    } else {
      console.log('================================================================');
      console.log(' 🚨 TRELLIS API — INCIDENT DRILL EXECUTABLE VERIFICATION SUITE');
      console.log('================================================================');
      console.log(`Executed At:      ${suiteReport.executedAt}`);
      console.log(`Total Scenarios:  ${suiteReport.totalScenarios}`);
      console.log(`Passed Scenarios: ${suiteReport.passedScenarios}`);
      console.log(`Failed Scenarios: ${suiteReport.failedScenarios}`);
      console.log(`Verified Steps:   ${suiteReport.passedSteps}/${suiteReport.totalSteps}`);
      console.log(`Execution Time:   ${suiteReport.durationMs}ms\n`);

      for (const scenario of suiteReport.scenarios) {
        printScenarioReport(scenario);
      }

      console.log('================================================================');
      if (suiteReport.allPassed) {
        console.log('🎉 OVERALL STATUS: ALL INCIDENT DRILL CHECKS PASSED');
      } else {
        console.log('⚠️  OVERALL STATUS: INCIDENT DRILL VERIFICATION FAILED');
      }
      console.log('================================================================\n');
    }

    process.exit(suiteReport.allPassed ? 0 : 1);
  } catch (err: any) {
    if (isJson) {
      console.error(JSON.stringify({ error: err.message, stack: err.stack }));
    } else {
      console.error('❌ Incident drill execution encountered a fatal error:', err.message);
    }
    process.exit(1);
  }
}

function printScenarioReport(scenario: IncidentDrillScenarioReport) {
  const badge = scenario.passed ? '✅ PASS' : '❌ FAIL';
  console.log('----------------------------------------------------------------');
  console.log(`${badge} | [${scenario.severity}] ${scenario.scenarioId}`);
  console.log(`       Title:      ${scenario.title}`);
  console.log(`       Subsystems: ${scenario.subsystems.join(', ')}`);
  console.log(
    `       Impact:     ${scenario.userImpact.affectedUserCount} user(s), exposure=${scenario.userImpact.totalExposureUnits}, notifications=${scenario.userImpact.notificationsQueued}`,
  );
  console.log('----------------------------------------------------------------');
  for (const step of scenario.steps) {
    const stepIcon = step.passed ? '  ✓' : '  ✗';
    console.log(
      `${stepIcon} [${step.phase.padEnd(22)}] ${step.name}: ${step.detail}`,
    );
  }
  console.log('');
}

runIncidentDrillCli();
