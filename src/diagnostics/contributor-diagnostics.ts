/**
 * Contributor diagnostics command extension — Issue #567
 *
 * Extends the existing diagnostics infrastructure with two additions:
 *
 *  1. `runContributorChecks` — a pure function that runs contributor-specific
 *     environment checks (Node version, npm/pnpm, build toolchain, CI secret
 *     hygiene) and returns structured DiagnosticCheck results. It is wired
 *     into the existing `diagnostics.ts` script's `tools` and `build` sections
 *     without modifying any other section.
 *
 *  2. `formatContributorReport` — a pure formatter that takes DiagnosticCheck[]
 *     and renders a contributor-focused summary block for ANSI terminals and
 *     plain-text CI logs.
 *
 * Design decisions
 * ─────────────────
 * • All I/O is injected via `ContributorDiagnosticsIO` so every path is
 *   unit-testable without spawning real child processes.
 * • No global state — results accumulate in a local array returned to callers.
 * • The existing `diagnostics-checks.ts` and `diagnostics-report.ts` files are
 *   NOT modified; this file exports a compatible `DiagnosticCheck[]`.
 * • Time complexity: O(n) for n checks; Space: O(n).
 *
 * Usage (added to `scripts/diagnostics.ts` `tools` section)
 * ──────────────────────────────────────────────────────────
 *   const { runContributorChecks } = require('../src/diagnostics/contributor-diagnostics');
 *   const contributorChecks = await runContributorChecks(io);
 *   results.push(...contributorChecks);
 */

import { DiagnosticCheck } from './diagnostics-checks';

// ─── Injected I/O surface (testable, no child_process at import time) ─────────

export interface ContributorDiagnosticsIO {
  /**
   * Synchronously runs a command and returns stdout trimmed,
   * or null if the command fails / is not found.
   */
  exec(command: string): string | null;

  /**
   * Returns the value of an environment variable, or undefined if unset.
   */
  getEnv(key: string): string | undefined;

  /**
   * Returns the contents of a file relative to the project root,
   * or null if the file does not exist or cannot be read.
   */
  readFile(relativePath: string): string | null;
}

// ─── Version constraints ──────────────────────────────────────────────────────

/** Minimum Node.js major version required by the project. */
export const MIN_NODE_MAJOR = 20;

/** Minimum npm major version required. */
export const MIN_NPM_MAJOR = 10;

// ─── Individual check builders ────────────────────────────────────────────────

/**
 * Verifies that the Node.js runtime meets the project's minimum version.
 *
 * Recovery: Install Node.js >= 20 via https://nodejs.org or nvm.
 */
export function checkNodeVersion(io: ContributorDiagnosticsIO): DiagnosticCheck {
  const raw = io.exec('node --version');
  if (!raw) {
    return {
      name: 'tools:node',
      status: 'fail',
      detail: 'node binary not found on PATH',
      remediation: `Install Node.js >= ${MIN_NODE_MAJOR} from https://nodejs.org or via nvm.`,
    };
  }

  // raw is e.g. "v20.11.0"
  const match = raw.match(/^v?(\d+)/);
  const major = match ? parseInt(match[1], 10) : NaN;

  if (Number.isNaN(major)) {
    return {
      name: 'tools:node',
      status: 'warn',
      detail: `Unexpected node version string: "${raw}"`,
      remediation: 'Verify the node installation with `node --version`.',
    };
  }

  if (major < MIN_NODE_MAJOR) {
    return {
      name: 'tools:node',
      status: 'fail',
      detail: `Node.js ${raw} is below the required v${MIN_NODE_MAJOR}.x`,
      remediation: `Upgrade to Node.js >= ${MIN_NODE_MAJOR}: https://nodejs.org or use nvm.`,
    };
  }

  return { name: 'tools:node', status: 'pass', detail: `Node.js ${raw}` };
}

/**
 * Verifies that npm meets the minimum major version.
 * The project uses npm scripts as the primary task runner.
 */
export function checkNpmVersion(io: ContributorDiagnosticsIO): DiagnosticCheck {
  const raw = io.exec('npm --version');
  if (!raw) {
    return {
      name: 'tools:npm',
      status: 'fail',
      detail: 'npm binary not found on PATH',
      remediation: 'npm ships with Node.js — reinstall Node.js to restore npm.',
    };
  }

  const major = parseInt(raw.split('.')[0], 10);
  if (Number.isNaN(major)) {
    return {
      name: 'tools:npm',
      status: 'warn',
      detail: `Unexpected npm version string: "${raw}"`,
    };
  }

  if (major < MIN_NPM_MAJOR) {
    return {
      name: 'tools:npm',
      status: 'fail',
      detail: `npm ${raw} is below the required v${MIN_NPM_MAJOR}.x`,
      remediation: `Run: npm install -g npm@latest`,
    };
  }

  return { name: 'tools:npm', status: 'pass', detail: `npm ${raw}` };
}

/**
 * Verifies that the TypeScript compiler is available via npx / local bin.
 * Checks the project-local version; does not require a global install.
 */
export function checkTypeScriptAvailable(io: ContributorDiagnosticsIO): DiagnosticCheck {
  const raw = io.exec('npx --no tsc --version');
  if (!raw || !raw.startsWith('Version')) {
    return {
      name: 'tools:tsc',
      status: 'fail',
      detail: 'TypeScript compiler (tsc) not available via npx',
      remediation: 'Run `npm install` to restore local devDependencies including typescript.',
    };
  }
  return { name: 'tools:tsc', status: 'pass', detail: raw };
}

/**
 * Verifies that the NestJS CLI is available via npx / local bin.
 */
export function checkNestCliAvailable(io: ContributorDiagnosticsIO): DiagnosticCheck {
  const raw = io.exec('npx --no nest --version');
  if (!raw) {
    return {
      name: 'tools:nest-cli',
      status: 'fail',
      detail: 'NestJS CLI not found',
      remediation: 'Run `npm install` to restore @nestjs/cli from devDependencies.',
    };
  }
  return { name: 'tools:nest-cli', status: 'pass', detail: `NestJS CLI ${raw.trim()}` };
}

/**
 * Checks that node_modules exists, indicating npm install has been run.
 * Does NOT run npm install — this check is intentionally read-only.
 */
export function checkNodeModulesPresent(io: ContributorDiagnosticsIO): DiagnosticCheck {
  const pkgLock = io.readFile('node_modules/.package-lock.json');
  const moduleExists = io.readFile('node_modules/@nestjs/core/package.json');
  if (!moduleExists) {
    return {
      name: 'build:node_modules',
      status: 'fail',
      detail: 'node_modules is missing or @nestjs/core is not installed',
      remediation: 'Run `npm install` from the project root.',
    };
  }
  return {
    name: 'build:node_modules',
    status: 'pass',
    detail: pkgLock ? 'node_modules present (package-lock.json found)' : 'node_modules present',
  };
}

/**
 * Checks that a .env file exists (copied from .env.example).
 * Does NOT parse or validate values — that is handled by `checkEnvVars` in
 * the existing diagnostics-checks module.
 */
export function checkDotEnvFile(io: ContributorDiagnosticsIO): DiagnosticCheck {
  const envContent = io.readFile('.env');
  if (!envContent) {
    return {
      name: 'build:dotenv',
      status: 'fail',
      detail: '.env file not found',
      remediation: 'Copy the template: `cp .env.example .env` then fill in your local values.',
    };
  }
  return { name: 'build:dotenv', status: 'pass', detail: '.env file present' };
}

/**
 * Checks that no CI-only secret placeholders appear in a contributor's .env.
 * Scans for the string "CHANGE_ME_IN_CI" which is intentionally left in the
 * .env.example for CI override but should never appear in a local dev file.
 *
 * Recovery: Replace every CHANGE_ME_IN_CI value with real local credentials.
 */
export function checkNoCiPlaceholdersInDotEnv(io: ContributorDiagnosticsIO): DiagnosticCheck {
  const content = io.readFile('.env');
  if (!content) {
    return { name: 'build:env-ci-placeholders', status: 'skip', detail: '.env not found' };
  }

  const matches = (content.match(/CHANGE_ME_IN_CI/g) ?? []).length;
  if (matches > 0) {
    return {
      name: 'build:env-ci-placeholders',
      status: 'warn',
      detail: `Found ${matches} CHANGE_ME_IN_CI placeholder(s) in .env`,
      remediation:
        'Replace CHANGE_ME_IN_CI values with real local credentials. ' +
        'These values are only valid inside CI and will cause local runs to fail.',
    };
  }

  return { name: 'build:env-ci-placeholders', status: 'pass', detail: 'No CI placeholders found' };
}

/**
 * Checks that ts-node is available — required for most npm run scripts.
 */
export function checkTsNodeAvailable(io: ContributorDiagnosticsIO): DiagnosticCheck {
  const raw = io.exec('npx --no ts-node --version');
  if (!raw) {
    return {
      name: 'tools:ts-node',
      status: 'fail',
      detail: 'ts-node not found',
      remediation: 'Run `npm install` to restore ts-node from devDependencies.',
    };
  }
  return { name: 'tools:ts-node', status: 'pass', detail: `ts-node ${raw.trim()}` };
}

/**
 * Checks that git is available and the working directory is inside a repo.
 * Many pre-commit hooks and scripts depend on git.
 */
export function checkGitAvailable(io: ContributorDiagnosticsIO): DiagnosticCheck {
  const raw = io.exec('git rev-parse --git-dir');
  if (!raw) {
    return {
      name: 'tools:git',
      status: 'fail',
      detail: 'git not found or working directory is not a git repository',
      remediation: 'Install git from https://git-scm.com and clone the repository.',
    };
  }
  return { name: 'tools:git', status: 'pass', detail: 'git available, inside a repository' };
}

// ─── Composite runner ─────────────────────────────────────────────────────────

/**
 * Runs all contributor diagnostics checks and returns them in declaration order.
 *
 * The function is async so callers can `await` it uniformly alongside existing
 * async diagnostics (TCP probes, DB auth checks).
 *
 * Time:  O(n) where n = number of checks (all synchronous under the hood)
 * Space: O(n) for the result array
 */
export async function runContributorChecks(
  io: ContributorDiagnosticsIO,
): Promise<DiagnosticCheck[]> {
  return [
    checkNodeVersion(io),
    checkNpmVersion(io),
    checkTypeScriptAvailable(io),
    checkNestCliAvailable(io),
    checkTsNodeAvailable(io),
    checkGitAvailable(io),
    checkNodeModulesPresent(io),
    checkDotEnvFile(io),
    checkNoCiPlaceholdersInDotEnv(io),
  ];
}

// ─── ANSI-free terminal formatter ─────────────────────────────────────────────

const STATUS_ICON: Record<DiagnosticCheck['status'], string> = {
  pass: '✔',
  fail: '✗',
  warn: '⚠',
  skip: '–',
};

const STATUS_LABEL: Record<DiagnosticCheck['status'], string> = {
  pass: 'PASS',
  fail: 'FAIL',
  warn: 'WARN',
  skip: 'SKIP',
};

/**
 * Formats contributor diagnostic results as a plain-text report block.
 * Compatible with the existing summary format in `scripts/diagnostics.ts`.
 *
 * Uses no ANSI codes so output is usable in CI logs and plain-text files.
 *
 * Time: O(n), Space: O(n)
 */
export function formatContributorReport(checks: DiagnosticCheck[]): string {
  const lines: string[] = [
    '─── Contributor Environment ─────────────────────────────────────────────',
  ];

  for (const check of checks) {
    const icon = STATUS_ICON[check.status];
    const label = STATUS_LABEL[check.status].padEnd(4);
    lines.push(`  ${icon} ${check.name.padEnd(35)} ${label}  ${check.detail}`);
    if ((check.status === 'fail' || check.status === 'warn') && check.remediation) {
      for (const line of check.remediation.split('\n')) {
        lines.push(`      ↳ ${line}`);
      }
    }
  }

  const passed = checks.filter((c) => c.status === 'pass').length;
  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  const skipped = checks.filter((c) => c.status === 'skip').length;

  lines.push('────────────────────────────────────────────────────────────────────────');
  lines.push(`  ${passed} passed  ${failed} failed  ${warned} warnings  ${skipped} skipped`);

  return lines.join('\n');
}
