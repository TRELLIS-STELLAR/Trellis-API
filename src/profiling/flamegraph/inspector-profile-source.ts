import { Session } from "inspector";
import type { CpuProfile } from "./flamegraph";

/**
 * Production profile source backed by the V8 inspector CPU profiler (#527).
 *
 * Samples the running process for `durationMs`, then returns the `.cpuprofile`
 * document. The session is always disabled and disconnected, including when a
 * step fails, so a failed capture cannot leave the profiler running.
 */
export function inspectorProfileSource(
  samplingIntervalUs = 1000,
): (durationMs: number) => Promise<CpuProfile> {
  return async (durationMs: number) => {
    const session = new Session();
    session.connect();
    const post = <T = unknown>(
      method: string,
      params: object = {},
    ): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        session.post(method, params, (err: Error | null, result?: unknown) => {
          if (err) reject(err);
          else resolve(result as T);
        });
      });

    try {
      await post("Profiler.enable");
      await post("Profiler.setSamplingInterval", {
        interval: samplingIntervalUs,
      });
      await post("Profiler.start");
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      const { profile } = await post<{ profile: CpuProfile }>("Profiler.stop");
      return profile;
    } finally {
      try {
        await post("Profiler.disable");
      } catch {
        // Best effort: the session is disconnected below either way.
      }
      session.disconnect();
    }
  };
}
