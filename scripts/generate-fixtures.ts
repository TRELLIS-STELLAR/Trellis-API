#!/usr/bin/env ts-node
/**
 * CLI script to generate local deterministic fixtures for Trellis API testing.
 *
 * Usage:
 *   npx ts-node scripts/generate-fixtures.ts [--seed=42] [--output=filepath.json] [--pretty]
 */

import * as fs from 'fs';
import * as path from 'path';
import { generateFixtures } from '../src/testing/fixtures/fixture-generator';

function parseArgs(): { seed: number; output?: string; pretty: boolean } {
  const args = process.argv.slice(2);
  let seed = 42;
  let output: string | undefined;
  let pretty = true;

  for (const arg of args) {
    if (arg.startsWith('--seed=')) {
      const parsedSeed = parseInt(arg.split('=')[1], 10);
      if (!isNaN(parsedSeed)) {
        seed = parsedSeed;
      }
    } else if (arg.startsWith('--output=')) {
      output = arg.split('=')[1];
    } else if (arg === '--compact') {
      pretty = false;
    }
  }

  return { seed, output, pretty };
}

function main(): void {
  const options = parseArgs();
  const dataset = generateFixtures({ seed: options.seed });
  const jsonContent = options.pretty
    ? JSON.stringify(dataset, null, 2)
    : JSON.stringify(dataset);

  if (options.output) {
    const targetPath = path.resolve(process.cwd(), options.output);
    const parentDir = path.dirname(targetPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    fs.writeFileSync(targetPath, jsonContent, 'utf-8');
    console.log(`[Fixtures] Deterministic dataset (seed=${options.seed}) written to ${targetPath}`);
  } else {
    console.log(jsonContent);
  }
}

if (require.main === module) {
  main();
}
