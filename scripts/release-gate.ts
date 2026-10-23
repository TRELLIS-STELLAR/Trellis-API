#!/usr/bin/env ts-node
/**
 * Release gate CLI (issue #372).
 *
 * Usage:
 *   npm run release:gate -- path/to/evidence.json
 *
 * Reads a release evidence document, prints the decision, and exits 1 when the
 * release is blocked (2 on unreadable or malformed input). Read-only.
 */

import * as fs from "fs";
import { evaluateReleaseGate } from "../src/common/release/release-gate";

function main(): number {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: npm run release:gate -- <evidence.json>");
    return 2;
  }

  let evidence;
  try {
    evidence = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`Cannot read evidence file: ${(err as Error).message}`);
    return 2;
  }
  if (!evidence?.releaseId || !evidence.tests || !Array.isArray(evidence.migrations)) {
    console.error("Evidence must include releaseId, tests, and a migrations array");
    return 2;
  }

  const decision = evaluateReleaseGate(evidence);
  console.log(JSON.stringify(decision, null, 2));
  return decision.decision === "PASS" ? 0 : 1;
}

process.exit(main());
