/**
 * Deterministic schedule replay for concurrent writes and retries (#262).
 *
 * `concurrency-harness.ts` races real async flows; this module controls the
 * interleaving itself. Each actor is a small state machine whose `step()` is
 * one atomic unit (a read, a compare-and-set write, a retry decision). A
 * schedule is just the list of actor indices to step, so:
 *
 *  - any failing interleaving is reproducible from its `trace`
 *  - `exploreInterleavings` visits every distinct interleaving (bounded)
 *  - `seededSchedule` picks a pseudo-random interleaving from a seed, and
 *    the returned trace replays to the identical outcome
 *
 * No timers, no wall clock, no real concurrency: the same inputs always
 * produce the same trace and the same final state.
 */

export interface ReplayActor {
  name: string;
  /** Runs one atomic step. Returns `true` once the actor has finished. */
  step(): Promise<boolean> | boolean;
}

export interface ReplayScenario<S> {
  state: S;
  actors: ReplayActor[];
}

export type ScenarioFactory<S> = () => ReplayScenario<S>;

export interface ReplayResult<S> {
  state: S;
  /** Actor indices in the order they were stepped. */
  trace: number[];
  /** Which actors finished. */
  done: boolean[];
}

const DEFAULT_MAX_STEPS = 1000;

/**
 * Steps a fresh scenario following `schedule` (skipping finished actors), then
 * runs any unfinished actors in index order until all are done.
 */
export async function replaySchedule<S>(
  create: ScenarioFactory<S>,
  schedule: readonly number[],
  maxSteps = DEFAULT_MAX_STEPS,
): Promise<ReplayResult<S>> {
  const scenario = create();
  const done = scenario.actors.map(() => false);
  const trace: number[] = [];

  const stepActor = async (index: number): Promise<void> => {
    if (trace.length >= maxSteps) {
      throw new Error(`Scenario exceeded ${maxSteps} steps; actors may not terminate`);
    }
    if (index < 0 || index >= scenario.actors.length) {
      throw new RangeError(`Schedule references unknown actor ${index}`);
    }
    trace.push(index);
    done[index] = await scenario.actors[index].step();
  };

  for (const index of schedule) {
    if (!done[index]) await stepActor(index);
  }
  for (let index = 0; index < scenario.actors.length; index += 1) {
    while (!done[index]) await stepActor(index);
  }
  return { state: scenario.state, trace, done };
}

/** mulberry32: tiny seedable PRNG so a seed fully determines a schedule. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Runs one pseudo-random interleaving chosen from `seed`. Replaying the
 * returned `trace` with `replaySchedule` reproduces the same final state.
 */
export async function runSeeded<S>(
  create: ScenarioFactory<S>,
  seed: number,
  maxSteps = DEFAULT_MAX_STEPS,
): Promise<ReplayResult<S>> {
  const random = seededRandom(seed);
  const scenario = create();
  const done = scenario.actors.map(() => false);
  const trace: number[] = [];

  for (;;) {
    const runnable = done.flatMap((finished, index) => (finished ? [] : [index]));
    if (!runnable.length) break;
    if (trace.length >= maxSteps) {
      throw new Error(`Scenario exceeded ${maxSteps} steps; actors may not terminate`);
    }
    const index = runnable[Math.floor(random() * runnable.length)];
    trace.push(index);
    done[index] = await scenario.actors[index].step();
  }
  return { state: scenario.state, trace, done };
}

export interface ExploreOptions {
  /** Stop after this many complete interleavings. Defaults to 20000. */
  maxSchedules?: number;
  maxSteps?: number;
}

export interface ExploreSummary {
  schedules: number;
  /** True when the search stopped at `maxSchedules` before covering everything. */
  truncated: boolean;
}

/**
 * Depth-first walk over every interleaving of the actors' steps. For each
 * complete interleaving the factory is rebuilt, the schedule replayed, and
 * `onComplete` called with the result so the caller can assert invariants.
 * Actors with retry loops are handled because runnable actors are discovered
 * dynamically from each replayed prefix.
 */
export async function exploreInterleavings<S>(
  create: ScenarioFactory<S>,
  onComplete: (result: ReplayResult<S>) => void,
  options: ExploreOptions = {},
): Promise<ExploreSummary> {
  const maxSchedules = options.maxSchedules ?? 20000;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  let schedules = 0;
  let truncated = false;

  const visit = async (prefix: number[]): Promise<void> => {
    if (truncated) return;
    if (prefix.length > maxSteps) {
      throw new Error(`Scenario exceeded ${maxSteps} steps; actors may not terminate`);
    }
    const probe = await replayPrefix(create, prefix);
    if (!probe.runnable.length) {
      if (schedules >= maxSchedules) {
        truncated = true;
        return;
      }
      schedules += 1;
      onComplete({ state: probe.state, trace: prefix, done: probe.done });
      return;
    }
    for (const index of probe.runnable) {
      await visit([...prefix, index]);
      if (truncated) return;
    }
  };

  await visit([]);
  return { schedules, truncated };
}

async function replayPrefix<S>(
  create: ScenarioFactory<S>,
  prefix: readonly number[],
): Promise<{ state: S; done: boolean[]; runnable: number[] }> {
  const scenario = create();
  const done = scenario.actors.map(() => false);
  for (const index of prefix) {
    done[index] = await scenario.actors[index].step();
  }
  const runnable = done.flatMap((finished, index) => (finished ? [] : [index]));
  return { state: scenario.state, done, runnable };
}
