/**
 * Tests for contributor diagnostics — Issue #567
 *
 * Covers:
 *  • Normal path: all tools present, .env clean → all pass
 *  • Failure path: missing binaries, missing .env → fail checks
 *  • Retry path: re-running after fix resolves failures (simulated via io swaps)
 *  • Authorization path: CI placeholders detected as warnings
 *  • Edge cases: unexpected version strings, empty .env, partial node_modules
 */

import {
  runContributorChecks,
  formatContributorReport,
  checkNodeVersion,
  checkNpmVersion,
  checkTypeScriptAvailable,
  checkNestCliAvailable,
  checkTsNodeAvailable,
  checkGitAvailable,
  checkNodeModulesPresent,
  checkDotEnvFile,
  checkNoCiPlaceholdersInDotEnv,
  ContributorDiagnosticsIO,
  MIN_NODE_MAJOR,
  MIN_NPM_MAJOR,
} from './contributor-diagnostics';

// ─── IO factories ─────────────────────────────────────────────────────────────

function makeIO(overrides: Partial<ContributorDiagnosticsIO> = {}): ContributorDiagnosticsIO {
  const defaults: ContributorDiagnosticsIO = {
    exec: (cmd) => {
      if (cmd.includes('node --version')) return `v${MIN_NODE_MAJOR}.11.0`;
      if (cmd.includes('npm --version')) return `${MIN_NPM_MAJOR}.2.0`;
      if (cmd.includes('tsc --version')) return 'Version 5.3.3';
      if (cmd.includes('nest --version')) return '10.3.2';
      if (cmd.includes('ts-node --version')) return 'v10.9.2';
      if (cmd.includes('git rev-parse')) return '.git';
      return null;
    },
    getEnv: () => undefined,
    readFile: (path) => {
      if (path === '.env') return 'DATABASE_URL=postgresql://localhost/dev\nJWT_SECRET=supersecret';
      if (path.includes('@nestjs/core/package.json')) return '{"version":"10.0.0"}';
      if (path.includes('.package-lock.json')) return '{}';
      return null;
    },
  };
  return { ...defaults, ...overrides };
}

function makeFailingIO(): ContributorDiagnosticsIO {
  return {
    exec: () => null,
    getEnv: () => undefined,
    readFile: () => null,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('contributor diagnostics (#567)', () => {
  // ── Normal path ──────────────────────────────────────────────────────────

  it('all checks pass with a fully configured environment', async () => {
    const io = makeIO();
    const results = await runContributorChecks(io);
    for (const check of results) {
      expect(['pass', 'skip']).toContain(check.status);
    }
  });

  it('runContributorChecks returns exactly 9 checks', async () => {
    const io = makeIO();
    const results = await runContributorChecks(io);
    expect(results).toHaveLength(9);
  });

  it('every passing check has no remediation field', async () => {
    const io = makeIO();
    const results = await runContributorChecks(io);
    for (const r of results.filter((c) => c.status === 'pass')) {
      expect(r.remediation).toBeUndefined();
    }
  });

  // ── Failure path: missing binaries ───────────────────────────────────────

  it('fails node check when binary is absent', () => {
    const io = makeIO({ exec: (cmd) => (cmd.includes('node --version') ? null : 'ok') });
    const result = checkNodeVersion(io);
    expect(result.status).toBe('fail');
    expect(result.remediation).toContain('nodejs.org');
  });

  it('fails npm check when binary is absent', () => {
    const io = makeIO({ exec: (cmd) => (cmd.includes('npm --version') ? null : 'ok') });
    const result = checkNpmVersion(io);
    expect(result.status).toBe('fail');
  });

  it('fails tsc check when npx cannot find tsc', () => {
    const io = makeIO({ exec: (cmd) => (cmd.includes('tsc --version') ? null : 'ok') });
    const result = checkTypeScriptAvailable(io);
    expect(result.status).toBe('fail');
    expect(result.remediation).toContain('npm install');
  });

  it('fails nest-cli check when CLI is absent', () => {
    const io = makeIO({ exec: (cmd) => (cmd.includes('nest --version') ? null : 'ok') });
    const result = checkNestCliAvailable(io);
    expect(result.status).toBe('fail');
  });

  it('fails ts-node check when ts-node is absent', () => {
    const io = makeIO({ exec: (cmd) => (cmd.includes('ts-node') ? null : 'ok') });
    const result = checkTsNodeAvailable(io);
    expect(result.status).toBe('fail');
  });

  it('fails git check when not inside a git repo', () => {
    const io = makeIO({ exec: (cmd) => (cmd.includes('git rev-parse') ? null : 'ok') });
    const result = checkGitAvailable(io);
    expect(result.status).toBe('fail');
  });

  it('fails node_modules check when @nestjs/core is not found', () => {
    const io = makeIO({
      readFile: (path) =>
        path.includes('@nestjs/core') ? null : 'content',
    });
    const result = checkNodeModulesPresent(io);
    expect(result.status).toBe('fail');
    expect(result.remediation).toContain('npm install');
  });

  it('fails .env check when file is absent', () => {
    const io = makeIO({ readFile: () => null });
    const result = checkDotEnvFile(io);
    expect(result.status).toBe('fail');
    expect(result.remediation).toContain('cp .env.example .env');
  });

  it('all checks fail gracefully when every IO call returns null', async () => {
    const results = await runContributorChecks(makeFailingIO());
    const failOrSkip = results.filter((r) => r.status === 'fail' || r.status === 'skip');
    expect(failOrSkip.length).toBeGreaterThan(0);
    // No throw, no undefined name
    for (const r of results) {
      expect(typeof r.name).toBe('string');
      expect(typeof r.detail).toBe('string');
    }
  });

  // ── Retry path ───────────────────────────────────────────────────────────

  it('re-running after fixing the environment resolves all failures (simulated)', async () => {
    // First pass: broken
    const broken = await runContributorChecks(makeFailingIO());
    const failCount = broken.filter((r) => r.status === 'fail').length;
    expect(failCount).toBeGreaterThan(0);

    // Second pass: fixed
    const fixed = await runContributorChecks(makeIO());
    const stillFailing = fixed.filter((r) => r.status === 'fail').length;
    expect(stillFailing).toBe(0);
  });

  // ── Authorization / CI-placeholder path ───────────────────────────────────

  it('warns when CHANGE_ME_IN_CI placeholders are present in .env', () => {
    const io = makeIO({
      readFile: (path) =>
        path === '.env'
          ? 'DATABASE_URL=CHANGE_ME_IN_CI\nJWT_SECRET=CHANGE_ME_IN_CI'
          : 'content',
    });
    const result = checkNoCiPlaceholdersInDotEnv(io);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('2');
    expect(result.remediation).toContain('CHANGE_ME_IN_CI');
  });

  it('passes CI-placeholder check when no placeholders are present', () => {
    const result = checkNoCiPlaceholdersInDotEnv(makeIO());
    expect(result.status).toBe('pass');
  });

  it('skips CI-placeholder check when .env is absent', () => {
    const io = makeIO({ readFile: () => null });
    const result = checkNoCiPlaceholdersInDotEnv(io);
    expect(result.status).toBe('skip');
  });

  // ── Version boundary edge cases ───────────────────────────────────────────

  it('fails node check for version below minimum', () => {
    const io = makeIO({ exec: (cmd) => (cmd.includes('node --version') ? `v${MIN_NODE_MAJOR - 1}.9.0` : 'ok') });
    const result = checkNodeVersion(io);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain(`v${MIN_NODE_MAJOR - 1}`);
  });

  it('passes node check at exactly the minimum version', () => {
    const io = makeIO({ exec: (cmd) => (cmd.includes('node --version') ? `v${MIN_NODE_MAJOR}.0.0` : 'ok') });
    const result = checkNodeVersion(io);
    expect(result.status).toBe('pass');
  });

  it('warns for an unexpected node version string rather than crashing', () => {
    const io = makeIO({ exec: (cmd) => (cmd.includes('node --version') ? 'nvm-shim' : 'ok') });
    const result = checkNodeVersion(io);
    expect(result.status).toBe('warn');
  });

  it('fails npm check for version below minimum', () => {
    const io = makeIO({ exec: (cmd) => (cmd.includes('npm --version') ? `${MIN_NPM_MAJOR - 1}.0.0` : 'ok') });
    const result = checkNpmVersion(io);
    expect(result.status).toBe('fail');
  });

  // ── formatContributorReport ───────────────────────────────────────────────

  it('formatContributorReport includes pass/fail/warn/skip counts', async () => {
    const checks = await runContributorChecks(makeIO());
    const report = formatContributorReport(checks);
    expect(report).toContain('passed');
    expect(report).toContain('failed');
    expect(report).toContain('warnings');
    expect(report).toContain('skipped');
  });

  it('formatContributorReport includes check names', async () => {
    const checks = await runContributorChecks(makeIO());
    const report = formatContributorReport(checks);
    expect(report).toContain('tools:node');
    expect(report).toContain('tools:npm');
    expect(report).toContain('build:dotenv');
  });

  it('formatContributorReport includes remediation for failed checks', () => {
    const checks = [
      checkNodeVersion(makeFailingIO()),
    ];
    const report = formatContributorReport(checks);
    expect(report).toContain('↳');
    expect(report).toContain('nodejs.org');
  });

  it('formatContributorReport is plain-text (no ANSI escape codes)', async () => {
    const checks = await runContributorChecks(makeIO());
    const report = formatContributorReport(checks);
    // ANSI escape sequences start with ESC (\x1b)
    expect(report).not.toMatch(/\x1b\[/);
  });
});
