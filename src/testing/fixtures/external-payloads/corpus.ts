import * as fs from "fs";
import * as path from "path";

/**
 * Golden fixture corpus for malformed external payloads and adversarial
 * records (#208).
 *
 * Every fixture is a checked-in JSON file describing one adversarial input
 * and the golden outcome the system must produce when the input hits the
 * real validation path named by `target`. The corpus is executed by
 * `external-payload-corpus.spec.ts`, which routes each fixture to the
 * production code path — never a re-implementation.
 *
 * See docs/FIXTURE_CORPUS.md for the operational runbook.
 */

/** Categories every corpus must cover (issue #208 acceptance criteria). */
export const REQUIRED_CATEGORIES = [
  "invalid-signature",
  "missing-fields",
  "oversized",
  "replay",
  "schema-drift",
  "tampered-record",
] as const;

export type FixtureCategory = (typeof REQUIRED_CATEGORIES)[number];

/** Validation paths a fixture may target. */
export const FIXTURE_TARGETS = [
  "payments.webhook-signature",
  "webhooks.inbound",
  "api.body-validation",
  "events.replay",
] as const;

export type FixtureTarget = (typeof FIXTURE_TARGETS)[number];

/** Golden outcome asserted against a fixture's validation path. */
export interface GoldenOutcome {
  /** payments.webhook-signature */
  ok?: boolean;
  reason?: string;
  status?: number;
  /** webhooks.inbound */
  accepted?: boolean;
  /** api.body-validation */
  rejected?: boolean;
  fields?: string[];
  sanitized?: Record<string, unknown>;
  /** events.replay */
  outcome?: string;
  applied?: number;
  upcasts?: Record<string, number>;
  poisonEvents?: Array<{
    sequence: number;
    eventName: string;
    reasonMatches: string;
  }>;
  errorMatches?: string;
  reportOutcome?: string;
}

/**
 * Fixed instant every fixture is replayed against, so corpus results are
 * deterministic. Fixtures that reference "now" embed the corresponding
 * literal values (unix seconds `1800000000`).
 */
export const CORPUS_NOW_MS = 1_800_000_000_000;
export const CORPUS_NOW_SECONDS = CORPUS_NOW_MS / 1000;

/** Shared secrets baked into fixtures; test-only, never real credentials. */
export const CORPUS_SECRETS = {
  stripe: "corpus_stripe_secret",
  inboundSigningKey: "corpus_inbound_key",
  generic: "corpus_generic_secret",
} as const;

export interface GoldenFixture {
  /** Matches the file name without `.json`; unique across the corpus. */
  id: string;
  /** Matches the directory the fixture lives in. */
  category: FixtureCategory;
  target: FixtureTarget;
  /** One line: what makes this input adversarial. */
  description: string;
  input: Record<string, unknown>;
  /** The golden outcome asserted against the real code path. */
  expected: GoldenOutcome;
}

export interface LoadedFixture {
  fixture: GoldenFixture;
  /** Absolute path, for failure messages that point at the golden file. */
  file: string;
}

/** Every `*.json` under a category directory, sorted by id. */
export function loadCorpus(rootDir = __dirname): LoadedFixture[] {
  const loaded: LoadedFixture[] = [];

  for (const category of fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()) {
    const categoryDir = path.join(rootDir, category);

    for (const fileName of fs
      .readdirSync(categoryDir)
      .filter((name) => name.endsWith(".json"))
      .sort()) {
      const file = path.join(categoryDir, fileName);
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as GoldenFixture;

      loaded.push({ fixture: parsed, file });
    }
  }

  return loaded;
}
