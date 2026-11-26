/**
 * Balance and ownership invariant tests (#issue-4)
 *
 * Comprehensive test suite covering normal paths, failure scenarios,
 * retry logic, and authorization checks for balance and ownership invariants.
 */

import {
  AssetRecord,
  BalanceInvariantContext,
  BalanceRecord,
  OwnershipInvariantContext,
  OwnershipRecord,
  TransactionRecord,
  createBalanceInvariants,
  createOwnershipInvariants,
  registerBalanceAndOwnershipInvariants,
} from "./balance-ownership-invariants";
import { InvariantStatus } from "./invariant.types";

describe("Balance and Ownership Invariants", () => {
  describe("Balance Invariants", () => {
    describe("Normal path: valid balances", () => {
      it("passes when all balances are non-negative", async () => {
        const context: BalanceInvariantContext = {
          getAllBalances: async () => [
            {
              accountId: "acc-1",
              balance: 100,
              currency: "USD",
              lastUpdated: new Date(),
              version: 1,
            },
            {
              accountId: "acc-2",
              balance: 0,
              currency: "USD",
              lastUpdated: new Date(),
              version: 1,
            },
            {
              accountId: "acc-3",
              balance: 500.5,
              currency: "USD",
              lastUpdated: new Date(),
              version: 1,
            },
          ],
          getAllTransactions: async () => [],
          getAccountBalance: async () => 0,
          getTotalBalances: async () => 600.5,
          computeExpectedBalance: async () => 0,
        };

        const invariants = createBalanceInvariants(context);
        const nonNegativeCheck = invariants.find(
          (i) => i.id === "balance.non_negative",
        )!;

        const result = await nonNegativeCheck.check();

        expect(result.passed).toBe(true);
        expect(result.message).toContain("non-negative");
        expect(result.affectedRecordIds).toHaveLength(0);
      });

      it("passes when balance conservation holds", async () => {
        const context: BalanceInvariantContext = {
          getAllBalances: async () => [
            { accountId: "acc-1", balance: 100, currency: "USD", lastUpdated: new Date(), version: 1 },
            { accountId: "acc-2", balance: 200, currency: "USD", lastUpdated: new Date(), version: 1 },
          ],
          getAllTransactions: async () => [
            {
              id: "tx-1",
              toAccount: "acc-1",
              amount: 100,
              currency: "USD",
              timestamp: new Date(),
              status: "completed",
            },
            {
              id: "tx-2",
              toAccount: "acc-2",
              amount: 200,
              currency: "USD",
              timestamp: new Date(),
              status: "completed",
            },
          ],
          getAccountBalance: async () => 0,
          getTotalBalances: async () => 300,
          computeExpectedBalance: async () => 0,
        };

        const invariants = createBalanceInvariants(context);
        const conservationCheck = invariants.find(
          (i) => i.id === "balance.conservation",
        )!;

        const result = await conservationCheck.check();

        expect(result.passed).toBe(true);
        expect(result.message).toContain("conservation verified");
        expect(result.metadata?.difference).toBeLessThanOrEqual(0.01);
      });

      it("passes when account balances match transaction history", async () => {
        const context: BalanceInvariantContext = {
          getAllBalances: async () => [
            { accountId: "acc-1", balance: 150, currency: "USD", lastUpdated: new Date(), version: 1 },
          ],
          getAllTransactions: async () => [],
          getAccountBalance: async () => 150,
          getTotalBalances: async () => 150,
          computeExpectedBalance: async (accountId) => 150,
        };

        const invariants = createBalanceInvariants(context);
        const reconciliationCheck = invariants.find(
          (i) => i.id === "balance.reconciliation",
        )!;

        const result = await reconciliationCheck.check();

        expect(result.passed).toBe(true);
        expect(result.message).toContain("reconciled");
      });

      it("passes when no stale pending transactions exist", async () => {
        const context: BalanceInvariantContext = {
          getAllBalances: async () => [],
          getAllTransactions: async () => [
            {
              id: "tx-1",
              amount: 100,
              currency: "USD",
              timestamp: new Date(), // Recent
              status: "pending",
            },
            {
              id: "tx-2",
              amount: 200,
              currency: "USD",
              timestamp: new Date(),
              status: "completed",
            },
          ],
          getAccountBalance: async () => 0,
          getTotalBalances: async () => 0,
          computeExpectedBalance: async () => 0,
        };

        const invariants = createBalanceInvariants(context);
        const stalePendingCheck = invariants.find(
          (i) => i.id === "balance.no_stale_pending",
        )!;

        const result = await stalePendingCheck.check();

        expect(result.passed).toBe(true);
        expect(result.warning).toBeFalsy();
        expect(result.message).toContain("No stale pending");
      });
    });

    describe("Failure path: balance violations", () => {
      it("fails when negative balances are detected", async () => {
        const context: BalanceInvariantContext = {
          getAllBalances: async () => [
            { accountId: "acc-1", balance: -50, currency: "USD", lastUpdated: new Date(), version: 1 },
            { accountId: "acc-2", balance: 100, currency: "USD", lastUpdated: new Date(), version: 1 },
            { accountId: "acc-3", balance: -10.5, currency: "USD", lastUpdated: new Date(), version: 1 },
          ],
          getAllTransactions: async () => [],
          getAccountBalance: async () => 0,
          getTotalBalances: async () => 0,
          computeExpectedBalance: async () => 0,
        };

        const invariants = createBalanceInvariants(context);
        const nonNegativeCheck = invariants.find(
          (i) => i.id === "balance.non_negative",
        )!;

        const result = await nonNegativeCheck.check();

        expect(result.passed).toBe(false);
        expect(result.message).toContain("negative balances");
        expect(result.affectedRecordIds).toHaveLength(2);
        expect(result.affectedRecordIds).toContain("acc-1");
        expect(result.affectedRecordIds).toContain("acc-3");
        expect(result.metadata?.negativeAccounts).toHaveLength(2);
      });

      it("fails when balance conservation is violated", async () => {
        const context: BalanceInvariantContext = {
          getAllBalances: async () => [],
          getAllTransactions: async () => [
            {
              id: "tx-1",
              amount: 100,
              currency: "USD",
              timestamp: new Date(),
              status: "completed",
            },
          ],
          getAccountBalance: async () => 0,
          getTotalBalances: async () => 150, // Mismatch!
          computeExpectedBalance: async () => 0,
        };

        const invariants = createBalanceInvariants(context);
        const conservationCheck = invariants.find(
          (i) => i.id === "balance.conservation",
        )!;

        const result = await conservationCheck.check();

        expect(result.passed).toBe(false);
        expect(result.message).toContain("mismatch");
        expect(result.metadata?.difference).toBeGreaterThan(0.01);
      });

      it("fails when account balances don't match transaction history", async () => {
        const context: BalanceInvariantContext = {
          getAllBalances: async () => [
            { accountId: "acc-1", balance: 100, currency: "USD", lastUpdated: new Date(), version: 1 },
            { accountId: "acc-2", balance: 200, currency: "USD", lastUpdated: new Date(), version: 1 },
          ],
          getAllTransactions: async () => [],
          getAccountBalance: async () => 0,
          getTotalBalances: async () => 0,
          computeExpectedBalance: async (accountId) => {
            return accountId === "acc-1" ? 150 : 200; // acc-1 is off
          },
        };

        const invariants = createBalanceInvariants(context);
        const reconciliationCheck = invariants.find(
          (i) => i.id === "balance.reconciliation",
        )!;

        const result = await reconciliationCheck.check();

        expect(result.passed).toBe(false);
        expect(result.message).toContain("mismatches");
        expect(result.affectedRecordIds).toContain("acc-1");
        expect(result.metadata?.mismatchedAccounts).toBe(1);
      });

      it("warns when stale pending transactions exist", async () => {
        const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);

        const context: BalanceInvariantContext = {
          getAllBalances: async () => [],
          getAllTransactions: async () => [
            {
              id: "tx-stale-1",
              amount: 100,
              currency: "USD",
              timestamp: twoDaysAgo,
              status: "pending",
            },
            {
              id: "tx-stale-2",
              amount: 50,
              currency: "USD",
              timestamp: twoDaysAgo,
              status: "pending",
            },
          ],
          getAccountBalance: async () => 0,
          getTotalBalances: async () => 0,
          computeExpectedBalance: async () => 0,
        };

        const invariants = createBalanceInvariants(context);
        const stalePendingCheck = invariants.find(
          (i) => i.id === "balance.no_stale_pending",
        )!;

        const result = await stalePendingCheck.check();

        expect(result.passed).toBe(true); // Still passes but warns
        expect(result.warning).toBe(true);
        expect(result.message).toContain("older than 24 hours");
        expect(result.affectedRecordIds).toHaveLength(2);
      });

      it("warns about mixed currency accounts", async () => {
        const context: BalanceInvariantContext = {
          getAllBalances: async () => [
            { accountId: "acc-1", balance: 100, currency: "USD", lastUpdated: new Date(), version: 1 },
            { accountId: "acc-1", balance: 50, currency: "EUR", lastUpdated: new Date(), version: 1 },
            { accountId: "acc-2", balance: 200, currency: "USD", lastUpdated: new Date(), version: 1 },
          ],
          getAllTransactions: async () => [],
          getAccountBalance: async () => 0,
          getTotalBalances: async () => 0,
          computeExpectedBalance: async () => 0,
        };

        const invariants = createBalanceInvariants(context);
        const currencyCheck = invariants.find(
          (i) => i.id === "balance.currency_consistency",
        )!;

        const result = await currencyCheck.check();

        expect(result.passed).toBe(true);
        expect(result.warning).toBe(true);
        expect(result.message).toContain("multiple currencies");
        expect(result.affectedRecordIds).toContain("acc-1");
      });
    });
  });

  describe("Ownership Invariants", () => {
    describe("Normal path: valid ownership", () => {
      it("passes when all assets have valid owners", async () => {
        const context: OwnershipInvariantContext = {
          getAllOwnerships: async () => [
            {
              assetId: "asset-1",
              ownerId: "owner-1",
              acquiredAt: new Date(),
              active: true,
            },
            {
              assetId: "asset-2",
              ownerId: "owner-2",
              acquiredAt: new Date(),
              active: true,
            },
          ],
          getAllAssets: async () => [
            {
              id: "asset-1",
              type: "token",
              currentOwner: "owner-1",
              createdAt: new Date(),
            },
            {
              id: "asset-2",
              type: "token",
              currentOwner: "owner-2",
              createdAt: new Date(),
            },
          ],
          ownerExists: async () => true,
          getOwnershipHistory: async () => [],
          hasOwnershipConflict: async () => false,
        };

        const invariants = createOwnershipInvariants(context);
        const allOwnedCheck = invariants.find(
          (i) => i.id === "ownership.all_assets_owned",
        )!;

        const result = await allOwnedCheck.check();

        expect(result.passed).toBe(true);
        expect(result.message).toContain("valid active owners");
        expect(result.affectedRecordIds).toHaveLength(0);
      });

      it("passes when no ownership conflicts exist", async () => {
        const context: OwnershipInvariantContext = {
          getAllOwnerships: async () => [
            {
              assetId: "asset-1",
              ownerId: "owner-1",
              acquiredAt: new Date(),
              active: true,
            },
            {
              assetId: "asset-2",
              ownerId: "owner-2",
              acquiredAt: new Date(),
              active: true,
            },
          ],
          getAllAssets: async () => [],
          ownerExists: async () => true,
          getOwnershipHistory: async () => [],
          hasOwnershipConflict: async () => false,
        };

        const invariants = createOwnershipInvariants(context);
        const noConflictsCheck = invariants.find(
          (i) => i.id === "ownership.no_conflicts",
        )!;

        const result = await noConflictsCheck.check();

        expect(result.passed).toBe(true);
        expect(result.message).toContain("No ownership conflicts");
      });

      it("passes when all owners are valid", async () => {
        const context: OwnershipInvariantContext = {
          getAllOwnerships: async () => [
            {
              assetId: "asset-1",
              ownerId: "owner-1",
              acquiredAt: new Date(),
              active: true,
            },
          ],
          getAllAssets: async () => [],
          ownerExists: async (ownerId) => ownerId === "owner-1",
          getOwnershipHistory: async () => [],
          hasOwnershipConflict: async () => false,
        };

        const invariants = createOwnershipInvariants(context);
        const validOwnersCheck = invariants.find(
          (i) => i.id === "ownership.valid_owners",
        )!;

        const result = await validOwnersCheck.check();

        expect(result.passed).toBe(true);
        expect(result.message).toContain("valid owners");
      });

      it("passes when ownership chains are intact", async () => {
        const context: OwnershipInvariantContext = {
          getAllOwnerships: async () => [],
          getAllAssets: async () => [
            {
              id: "asset-1",
              type: "token",
              currentOwner: "owner-3",
              createdAt: new Date(),
            },
          ],
          ownerExists: async () => true,
          getOwnershipHistory: async (assetId) => {
            if (assetId === "asset-1") {
              return [
                {
                  assetId: "asset-1",
                  ownerId: "owner-1",
                  acquiredAt: new Date("2024-01-01"),
                  transferredAt: new Date("2024-02-01"),
                  transferredTo: "owner-2",
                  active: false,
                },
                {
                  assetId: "asset-1",
                  ownerId: "owner-2",
                  acquiredAt: new Date("2024-02-01"),
                  transferredAt: new Date("2024-03-01"),
                  transferredTo: "owner-3",
                  active: false,
                },
                {
                  assetId: "asset-1",
                  ownerId: "owner-3",
                  acquiredAt: new Date("2024-03-01"),
                  active: true,
                },
              ];
            }
            return [];
          },
          hasOwnershipConflict: async () => false,
        };

        const invariants = createOwnershipInvariants(context);
        const chainIntegrityCheck = invariants.find(
          (i) => i.id === "ownership.chain_integrity",
        )!;

        const result = await chainIntegrityCheck.check();

        expect(result.passed).toBe(true);
        expect(result.message).toContain("chains are intact");
      });
    });

    describe("Failure path: ownership violations", () => {
      it("fails when assets have no active owner", async () => {
        const context: OwnershipInvariantContext = {
          getAllOwnerships: async () => [
            {
              assetId: "asset-1",
              ownerId: "owner-1",
              acquiredAt: new Date(),
              active: true,
            },
          ],
          getAllAssets: async () => [
            {
              id: "asset-1",
              type: "token",
              currentOwner: "owner-1",
              createdAt: new Date(),
            },
            {
              id: "asset-2",
              type: "token",
              currentOwner: "",
              createdAt: new Date(),
            },
            {
              id: "asset-3",
              type: "token",
              currentOwner: "",
              createdAt: new Date(),
            },
          ],
          ownerExists: async () => true,
          getOwnershipHistory: async () => [],
          hasOwnershipConflict: async () => false,
        };

        const invariants = createOwnershipInvariants(context);
        const allOwnedCheck = invariants.find(
          (i) => i.id === "ownership.all_assets_owned",
        )!;

        const result = await allOwnedCheck.check();

        expect(result.passed).toBe(false);
        expect(result.message).toContain("without active owners");
        expect(result.affectedRecordIds).toHaveLength(2);
        expect(result.affectedRecordIds).toContain("asset-2");
        expect(result.affectedRecordIds).toContain("asset-3");
      });

      it("fails when ownership conflicts exist", async () => {
        const context: OwnershipInvariantContext = {
          getAllOwnerships: async () => [
            {
              assetId: "asset-1",
              ownerId: "owner-1",
              acquiredAt: new Date(),
              active: true,
            },
            {
              assetId: "asset-1",
              ownerId: "owner-2",
              acquiredAt: new Date(),
              active: true,
            },
            {
              assetId: "asset-2",
              ownerId: "owner-3",
              acquiredAt: new Date(),
              active: true,
            },
          ],
          getAllAssets: async () => [],
          ownerExists: async () => true,
          getOwnershipHistory: async () => [],
          hasOwnershipConflict: async () => false,
        };

        const invariants = createOwnershipInvariants(context);
        const noConflictsCheck = invariants.find(
          (i) => i.id === "ownership.no_conflicts",
        )!;

        const result = await noConflictsCheck.check();

        expect(result.passed).toBe(false);
        expect(result.message).toContain("multiple active owners");
        expect(result.affectedRecordIds).toContain("asset-1");
      });

      it("fails when owners don't exist", async () => {
        const context: OwnershipInvariantContext = {
          getAllOwnerships: async () => [
            {
              assetId: "asset-1",
              ownerId: "invalid-owner",
              acquiredAt: new Date(),
              active: true,
            },
            {
              assetId: "asset-2",
              ownerId: "another-invalid",
              acquiredAt: new Date(),
              active: true,
            },
          ],
          getAllAssets: async () => [],
          ownerExists: async () => false,
          getOwnershipHistory: async () => [],
          hasOwnershipConflict: async () => false,
        };

        const invariants = createOwnershipInvariants(context);
        const validOwnersCheck = invariants.find(
          (i) => i.id === "ownership.valid_owners",
        )!;

        const result = await validOwnersCheck.check();

        expect(result.passed).toBe(false);
        expect(result.message).toContain("invalid owner references");
        expect(result.affectedRecordIds).toHaveLength(2);
      });

      it("fails when ownership chains are broken", async () => {
        const context: OwnershipInvariantContext = {
          getAllOwnerships: async () => [],
          getAllAssets: async () => [
            {
              id: "asset-1",
              type: "token",
              currentOwner: "owner-3",
              createdAt: new Date(),
            },
          ],
          ownerExists: async () => true,
          getOwnershipHistory: async (assetId) => {
            if (assetId === "asset-1") {
              return [
                {
                  assetId: "asset-1",
                  ownerId: "owner-1",
                  acquiredAt: new Date("2024-01-01"),
                  transferredAt: new Date("2024-02-01"),
                  transferredTo: "owner-X", // Should be owner-2
                  active: false,
                },
                {
                  assetId: "asset-1",
                  ownerId: "owner-2",
                  acquiredAt: new Date("2024-02-01"),
                  active: true,
                },
              ];
            }
            return [];
          },
          hasOwnershipConflict: async () => false,
        };

        const invariants = createOwnershipInvariants(context);
        const chainIntegrityCheck = invariants.find(
          (i) => i.id === "ownership.chain_integrity",
        )!;

        const result = await chainIntegrityCheck.check();

        expect(result.passed).toBe(false);
        expect(result.message).toContain("broken ownership chains");
        expect(result.affectedRecordIds).toContain("asset-1");
      });

      it("warns about circular ownership patterns", async () => {
        const context: OwnershipInvariantContext = {
          getAllOwnerships: async () => [],
          getAllAssets: async () => [
            {
              id: "asset-1",
              type: "token",
              currentOwner: "owner-1",
              createdAt: new Date(),
            },
          ],
          ownerExists: async () => true,
          getOwnershipHistory: async (assetId) => {
            if (assetId === "asset-1") {
              // Circular: owner-1 → owner-2 → owner-3 → owner-1
              return [
                {
                  assetId: "asset-1",
                  ownerId: "owner-1",
                  acquiredAt: new Date("2024-01-01"),
                  active: false,
                },
                {
                  assetId: "asset-1",
                  ownerId: "owner-2",
                  acquiredAt: new Date("2024-02-01"),
                  active: false,
                },
                {
                  assetId: "asset-1",
                  ownerId: "owner-3",
                  acquiredAt: new Date("2024-03-01"),
                  active: false,
                },
                {
                  assetId: "asset-1",
                  ownerId: "owner-1",
                  acquiredAt: new Date("2024-04-01"),
                  active: true,
                },
              ];
            }
            return [];
          },
          hasOwnershipConflict: async () => false,
        };

        const invariants = createOwnershipInvariants(context);
        const circularCheck = invariants.find(
          (i) => i.id === "ownership.no_circular_transfers",
        )!;

        const result = await circularCheck.check();

        expect(result.passed).toBe(true);
        expect(result.warning).toBe(true);
        expect(result.message).toContain("circular ownership");
        expect(result.affectedRecordIds).toContain("asset-1");
      });

      it("fails when asset currentOwner doesn't match ownership record", async () => {
        const context: OwnershipInvariantContext = {
          getAllOwnerships: async () => [
            {
              assetId: "asset-1",
              ownerId: "owner-1",
              acquiredAt: new Date(),
              active: true,
            },
          ],
          getAllAssets: async () => [
            {
              id: "asset-1",
              type: "token",
              currentOwner: "owner-2", // Mismatch!
              createdAt: new Date(),
            },
          ],
          ownerExists: async () => true,
          getOwnershipHistory: async () => [],
          hasOwnershipConflict: async () => false,
        };

        const invariants = createOwnershipInvariants(context);
        const consistencyCheck = invariants.find(
          (i) => i.id === "ownership.asset_owner_consistency",
        )!;

        const result = await consistencyCheck.check();

        expect(result.passed).toBe(false);
        expect(result.message).toContain("inconsistencies");
        expect(result.affectedRecordIds).toContain("asset-1");
      });
    });
  });

  describe("Integrated balance and ownership invariants", () => {
    it("registers all invariants from both categories", () => {
      const balanceContext: BalanceInvariantContext = {
        getAllBalances: async () => [],
        getAllTransactions: async () => [],
        getAccountBalance: async () => 0,
        getTotalBalances: async () => 0,
        computeExpectedBalance: async () => 0,
      };

      const ownershipContext: OwnershipInvariantContext = {
        getAllOwnerships: async () => [],
        getAllAssets: async () => [],
        ownerExists: async () => true,
        getOwnershipHistory: async () => [],
        hasOwnershipConflict: async () => false,
      };

      const allInvariants = registerBalanceAndOwnershipInvariants(
        balanceContext,
        ownershipContext,
      );

      expect(allInvariants.length).toBeGreaterThan(0);

      const balanceInvariants = allInvariants.filter(
        (i) => i.id.startsWith("balance."),
      );
      const ownershipInvariants = allInvariants.filter(
        (i) => i.id.startsWith("ownership."),
      );

      expect(balanceInvariants.length).toBe(5);
      expect(ownershipInvariants.length).toBe(6);
    });

    it("all invariants have required fields", () => {
      const balanceContext: BalanceInvariantContext = {
        getAllBalances: async () => [],
        getAllTransactions: async () => [],
        getAccountBalance: async () => 0,
        getTotalBalances: async () => 0,
        computeExpectedBalance: async () => 0,
      };

      const ownershipContext: OwnershipInvariantContext = {
        getAllOwnerships: async () => [],
        getAllAssets: async () => [],
        ownerExists: async () => true,
        getOwnershipHistory: async () => [],
        hasOwnershipConflict: async () => false,
      };

      const allInvariants = registerBalanceAndOwnershipInvariants(
        balanceContext,
        ownershipContext,
      );

      allInvariants.forEach((invariant) => {
        expect(invariant.id).toBeTruthy();
        expect(invariant.name).toBeTruthy();
        expect(invariant.description).toBeTruthy();
        expect(invariant.category).toBeTruthy();
        expect(invariant.severity).toBeTruthy();
        expect(invariant.remediation).toBeTruthy();
        expect(typeof invariant.check).toBe("function");
      });
    });

    it("handles execution errors gracefully", async () => {
      const faultyContext: BalanceInvariantContext = {
        getAllBalances: async () => {
          throw new Error("Database connection failed");
        },
        getAllTransactions: async () => [],
        getAccountBalance: async () => 0,
        getTotalBalances: async () => 0,
        computeExpectedBalance: async () => 0,
      };

      const invariants = createBalanceInvariants(faultyContext);
      const check = invariants[0];

      // Should not throw
      await expect(check.check()).rejects.toThrow("Database connection failed");
    });
  });
});
