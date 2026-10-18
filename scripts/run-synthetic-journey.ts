import { SyntheticJourneyMonitorService } from "../src/monitoring/synthetic-journey/synthetic-journey.service";

async function main() {
  console.log("==================================================================");
  console.log("🚀 Running Trellis Synthetic Journey Monitor CLI");
  console.log("==================================================================\n");

  const service = new SyntheticJourneyMonitorService();
  const startTime = Date.now();

  try {
    const report = await service.runJourney({ trigger: "CLI" });

    console.log(`Journey ID:    ${report.journeyId}`);
    console.log(`Workflow:      ${report.journeyName}`);
    console.log(`Overall Status:${report.status}`);
    console.log(`Duration:      ${report.durationMs}ms`);
    console.log(`Total Steps:   ${report.totalSteps}`);
    console.log(`Passed Steps:  ${report.passedSteps}`);
    console.log(`Failed Steps:  ${report.failedSteps}`);
    console.log(`Degraded Steps:${report.degradedSteps}`);
    console.log("------------------------------------------------------------------");
    console.log("Step Breakdown:");

    for (const step of report.steps) {
      const statusIcon =
        step.status === "PASSED"
          ? "✅"
          : step.status === "DEGRADED"
          ? "⚠️ "
          : step.status === "FAILED"
          ? "❌"
          : "⏭️ ";

      console.log(
        `  ${statusIcon} [${step.stepId}] ${step.stepName} (${step.targetService} -> ${step.dependency}): ${step.latencyMs}ms (SLA: ${step.slaThresholdMs}ms) [${step.status}]`,
      );

      if (step.error) {
        console.log(`     Error: ${step.error.message}`);
        console.log(`     Blame Target: ${step.error.blame}`);
        console.log(`     Remediation:  ${step.error.remediation}`);
      }
    }

    console.log("------------------------------------------------------------------");
    if (report.status === "FAILED") {
      console.error(`💥 Journey failed! Blame attributed to: ${report.dependencyBlame.join(", ")}`);
      process.exit(1);
    } else {
      console.log(`🎉 Journey succeeded in ${Date.now() - startTime}ms`);
      process.exit(0);
    }
  } catch (err: any) {
    console.error(`FATAL: Synthetic journey execution error: ${err.message}`);
    process.exit(1);
  }
}

main();
