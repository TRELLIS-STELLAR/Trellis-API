#!/usr/bin/env ts-node
/**
 * Versioned event replay CLI (#278).
 *
 * Rebuilds a projection from an exported event stream and prints the replay
 * report (applied / ignored / upcast counts, poison events, final state hash).
 * Read-only: it never touches the database, so it is safe to run against a
 * production export to check that a new projection version or upcaster
 * behaves before rebuilding for real through `POST /admin/projections/:name/rebuild`.
 *
 * Usage:
 *   npm run events:replay -- --projection user-directory --input events.ndjson
 *   npm run events:replay -- --projection user-directory --input ledger.json --on-poison skip
 *   npm run events:replay -- --list
 *
 * Input: NDJSON (one stored event per line: { sequence, eventId, eventName,
 * schemaVersion, timestamp, producer, payload, [previousHash, hash] }) or a
 * `TamperEvidentLedger` export (`{ entries: [...] }`), whose hash chain is
 * verified during replay.
 *
 * Exit codes: 0 replayed cleanly, 1 halted/aborted (poison event, broken
 * chain, out-of-order stream), 2 usage error.
 */
import * as fs from "fs";
import {
  arraySource,
  EventReplayEngine,
  InMemoryCheckpointStore,
  InMemoryProjectionStore,
  ProjectionDefinition,
  ReplayAbortedError,
  StoredEvent,
} from "../src/common/events/replay/event-replay";
import {
  DEFAULT_UPCASTERS,
  EventUpcasterRegistry,
} from "../src/common/events/replay/event-upcaster";
import { userDirectoryProjection } from "../src/common/events/replay/projections/user-directory.projection";

const PROJECTIONS: Record<string, ProjectionDefinition<any>> = {
  [userDirectoryProjection.name]: userDirectoryProjection,
};

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(message: string): never {
  console.error(
    `${message}\n\nUsage: events:replay --projection <name> --input <file> [--on-poison halt|skip] [--limit N] [--print-state]`,
  );
  process.exit(2);
}

export function parseEvents(raw: string): StoredEvent[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.includes('"entries"')) {
    const ledger = JSON.parse(trimmed) as { entries: StoredEvent[] };
    return ledger.entries;
  }
  return trimmed
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line, i) => {
      try {
        return JSON.parse(line) as StoredEvent;
      } catch {
        throw new Error(`Line ${i + 1} is not valid JSON`);
      }
    });
}

async function main(): Promise<void> {
  if (process.argv.includes("--list")) {
    for (const p of Object.values(PROJECTIONS)) {
      console.log(
        `${p.name}\tv${p.version}\thandles ${Object.entries(p.handles)
          .map(([e, v]) => `${e}@${v}`)
          .join(", ")}`,
      );
    }
    return;
  }

  const name = arg("projection") ?? usage("--projection is required");
  const input = arg("input") ?? usage("--input is required");
  const projection =
    PROJECTIONS[name] ?? usage(`Unknown projection '${name}'. Use --list.`);
  const onPoison = (arg("on-poison") ?? "halt") as "halt" | "skip";
  if (!["halt", "skip"].includes(onPoison))
    usage("--on-poison must be halt or skip");
  const limit = arg("limit") ? Number(arg("limit")) : undefined;

  const events = parseEvents(fs.readFileSync(input, "utf8"));
  const upcasters = new EventUpcasterRegistry();
  DEFAULT_UPCASTERS.forEach((u) => upcasters.register(u));
  const store = new InMemoryProjectionStore();
  const engine = new EventReplayEngine(
    new InMemoryCheckpointStore(),
    store,
    upcasters,
  );

  try {
    const report = await engine.rebuild(projection, arraySource(events), {
      onPoisonEvent: onPoison,
      limit,
    });
    console.log(JSON.stringify(report, null, 2));
    if (process.argv.includes("--print-state")) {
      console.log(
        JSON.stringify((await store.getActive(name))?.state ?? null, null, 2),
      );
    }
    process.exit(report.outcome === "halted" ? 1 : 0);
  } catch (error) {
    if (error instanceof ReplayAbortedError) {
      console.error(`Replay aborted: ${error.message}`);
      console.log(JSON.stringify(error.report, null, 2));
      process.exit(1);
    }
    throw error;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(2);
  });
}
