import { ProjectionDefinition } from "../event-replay";

/**
 * Example projection over `user.created` (#278): role and KYC tier per user
 * plus counts per tier. Written against schema v2.0, so v1.0 events are upcast
 * (gaining `kycTier: "unverified"`) before they reach `apply`.
 *
 * Email addresses are deliberately not projected: a read model has no need
 * for them, and keeping PII out of rebuilt state keeps replays safe to export.
 */
export interface UserDirectoryState {
  users: Record<string, { role: string; kycTier: string }>;
  countsByTier: Record<string, number>;
}

export const userDirectoryProjection: ProjectionDefinition<UserDirectoryState> =
  {
    name: "user-directory",
    version: 1,
    handles: { "user.created": "2.0" },
    initialState: () => ({ users: {}, countsByTier: {} }),
    apply(state, event) {
      const payload = event.payload as {
        userId: string;
        role: string;
        kycTier: string;
      };
      const previous = state.users[payload.userId];
      const countsByTier = { ...state.countsByTier };
      if (previous) {
        // Re-delivered creation: re-count rather than double count.
        countsByTier[previous.kycTier] = Math.max(
          0,
          (countsByTier[previous.kycTier] ?? 1) - 1,
        );
      }
      countsByTier[payload.kycTier] = (countsByTier[payload.kycTier] ?? 0) + 1;
      return {
        users: {
          ...state.users,
          [payload.userId]: { role: payload.role, kycTier: payload.kycTier },
        },
        countsByTier,
      };
    },
  };
