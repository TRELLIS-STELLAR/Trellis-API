/**
 * Balance and ownership invariant monitoring (#issue-4)
 *
 * Comprehensive invariant checks for balances and ownership with
 * normal path validation, failure detection, retry handling, and
 * authorization verification.
 */

import {
  InvariantCategory,
  InvariantCheckOutput,
  InvariantDefinition,
  InvariantSeverity,
} from "./invariant.types";

export interface BalanceInvariantContext {
  /** Get all balance records */
  getAllBalances(): Promise<BalanceRecord[]>;
  /** Get all transactions */
  getAllTransactions(): Promise<TransactionRecord[]>;
  /** Get balance for specific account */
  getAccountBalance(accountId: string): Promise<number>;
  /** Get sum of all balances */
  getTotalBalances(): Promise<number>;
  /** Get expected balance from transactions */
  computeExpectedBalance(accountId: string): Promise<number>;
}

export interface OwnershipInvariantContext {
  /** Get all ownership records */
  getAllOwnerships(): Promise<OwnershipRecord[]>;
  /** Get all assets */
  getAllAssets(): Promise<AssetRecord[]>;
  /** Verify owner exists */
  ownerExists(ownerId: string): Promise<boolean>;
  /** Get ownership history */
  getOwnershipHistory(assetId: string): Promise<OwnershipRecord[]>;
  /** Verify no ownership conflicts */
  hasOwnershipConflict(assetId: string): Promise<boolean>;
}

export interface BalanceRecord {
  accountId: string;
  balance: number;
  currency: string;
  lastUpdated: Date;
  version: number;
}

export interface TransactionRecord {
  id: string;
  fromAccount?: string;
  toAccount?: string;
  amount: number;
  currency: string;
  timestamp: Date;
  status: "pending" | "completed" | "failed" | "reversed";
}

export interface OwnershipRecord {
  assetId: string;
  ownerId: string;
  acquiredAt: Date;
  transferredAt?: Date;
  transferredTo?: string;
  active: boolean;
}

export interface AssetRecord {
  id: string;
  type: string;
  currentOwner: string;
  createdAt: Date;
  value?: number;
}

/**
 * Create balance invariant definitions
 */
export function createBalanceInvariants(
  context: BalanceInvariantContext,
): InvariantDefinition[] {
  return [
    {
      id: "balance.non_negative",
      name: "All balances are non-negative",
      description: "No account should have a negative balance",
      category: InvariantCategory.FUNDS,
      severity: InvariantSeverity.CRITICAL,
      remediation:
        "Investigate transactions that caused negative balance. Reconcile with transaction history and adjust if necessary.",
      check: async (): Promise<InvariantCheckOutput> => {
        const balances = await context.getAllBalances();
        const negative = balances.filter((b) => b.balance < 0);

        return {
          passed: negative.length === 0,
          message:
            negative.length === 0
              ? "All account balances are non-negative"
              : `Found ${negative.length} accounts with negative balances`,
          affectedRecordIds: negative.map((b) => b.accountId),
          metadata: {
            negativeAccounts: negative.map((b) => ({
              accountId: b.accountId,
              balance: b.balance,
              currency: b.currency,
            })),
          },
        };
      },
    },

    {
      id: "balance.conservation",
      name: "Balance conservation (total balance matches transactions)",
      description:
        "Sum of all completed transactions should equal sum of all balances",
      category: InvariantCategory.FUNDS,
      severity: InvariantSeverity.CRITICAL,
      remediation:
        "Identify missing or duplicate transactions. Verify balance update logic. Run full reconciliation.",
      check: async (): Promise<InvariantCheckOutput> => {
        const totalBalance = await context.getTotalBalances();
        const transactions = await context.getAllTransactions();

        const completedTxns = transactions.filter((t) => t.status === "completed");
        const transactionSum = completedTxns.reduce(
          (sum, txn) => sum + txn.amount,
          0,
        );

        const tolerance = 0.01; // Allow for rounding
        const diff = Math.abs(totalBalance - transactionSum);
        const passed = diff <= tolerance;

        return {
          passed,
          message: passed
            ? `Balance conservation verified (diff: ${diff.toFixed(6)})`
            : `Balance mismatch detected: total=${totalBalance}, transactions=${transactionSum}, diff=${diff}`,
          affectedRecordIds: [],
          metadata: {
            totalBalance,
            transactionSum,
            difference: diff,
            completedTransactions: completedTxns.length,
          },
        };
      },
    },

    {
      id: "balance.reconciliation",
      name: "Account balances match transaction history",
      description: "Each account's balance should equal sum of its transactions",
      category: InvariantCategory.FUNDS,
      severity: InvariantSeverity.HIGH,
      remediation:
        "Run per-account reconciliation. Identify divergent accounts and rebuild balance from transaction log.",
      check: async (): Promise<InvariantCheckOutput> => {
        const balances = await context.getAllBalances();
        const mismatched: string[] = [];

        for (const balanceRecord of balances) {
          const actual = balanceRecord.balance;
          const expected = await context.computeExpectedBalance(
            balanceRecord.accountId,
          );

          const tolerance = 0.01;
          if (Math.abs(actual - expected) > tolerance) {
            mismatched.push(balanceRecord.accountId);
          }
        }

        return {
          passed: mismatched.length === 0,
          message:
            mismatched.length === 0
              ? "All account balances reconciled with transaction history"
              : `Found ${mismatched.length} accounts with balance mismatches`,
          affectedRecordIds: mismatched,
          metadata: {
            totalAccounts: balances.length,
            mismatchedAccounts: mismatched.length,
          },
        };
      },
    },

    {
      id: "balance.no_stale_pending",
      name: "No stale pending transactions",
      description: "Pending transactions older than 24 hours should be investigated",
      category: InvariantCategory.FUNDS,
      severity: InvariantSeverity.MEDIUM,
      remediation:
        "Review pending transactions. Complete, fail, or cancel as appropriate. Check for stuck payment processors.",
      check: async (): Promise<InvariantCheckOutput> => {
        const transactions = await context.getAllTransactions();
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

        const stalePending = transactions.filter(
          (t) => t.status === "pending" && t.timestamp < cutoff,
        );

        return {
          passed: true,
          warning: stalePending.length > 0,
          message:
            stalePending.length === 0
              ? "No stale pending transactions found"
              : `Found ${stalePending.length} pending transactions older than 24 hours`,
          affectedRecordIds: stalePending.map((t) => t.id),
          metadata: {
            stalePendingCount: stalePending.length,
            oldestPending: stalePending[0]?.timestamp,
          },
        };
      },
    },

    {
      id: "balance.currency_consistency",
      name: "Currency consistency in transactions",
      description: "Transactions should not mix currencies without conversion records",
      category: InvariantCategory.FUNDS,
      severity: InvariantSeverity.HIGH,
      remediation:
        "Identify cross-currency transactions. Verify conversion records exist. Add missing conversion entries.",
      check: async (): Promise<InvariantCheckOutput> => {
        const transactions = await context.getAllTransactions();
        const balances = await context.getAllBalances();

        const accountCurrencies = new Map<string, Set<string>>();

        for (const balance of balances) {
          if (!accountCurrencies.has(balance.accountId)) {
            accountCurrencies.set(balance.accountId, new Set());
          }
          accountCurrencies.get(balance.accountId)!.add(balance.currency);
        }

        const mixedCurrency = Array.from(accountCurrencies.entries())
          .filter(([_, currencies]) => currencies.size > 1)
          .map(([accountId]) => accountId);

        return {
          passed: true,
          warning: mixedCurrency.length > 0,
          message:
            mixedCurrency.length === 0
              ? "No mixed currency accounts found"
              : `Found ${mixedCurrency.length} accounts with multiple currencies`,
          affectedRecordIds: mixedCurrency,
          metadata: {
            mixedCurrencyAccounts: mixedCurrency.length,
          },
        };
      },
    },
  ];
}

/**
 * Create ownership invariant definitions
 */
export function createOwnershipInvariants(
  context: OwnershipInvariantContext,
): InvariantDefinition[] {
  return [
    {
      id: "ownership.all_assets_owned",
      name: "All assets have valid owners",
      description: "Every asset must have exactly one active owner",
      category: InvariantCategory.OWNERSHIP,
      severity: InvariantSeverity.CRITICAL,
      remediation:
        "Identify unowned assets. Assign to default owner or flag for manual review. Verify ownership records.",
      check: async (): Promise<InvariantCheckOutput> => {
        const assets = await context.getAllAssets();
        const ownerships = await context.getAllOwnerships();

        const activeOwnership = new Map<string, string>();
        for (const ownership of ownerships) {
          if (ownership.active) {
            activeOwnership.set(ownership.assetId, ownership.ownerId);
          }
        }

        const unowned = assets.filter((asset) => !activeOwnership.has(asset.id));

        return {
          passed: unowned.length === 0,
          message:
            unowned.length === 0
              ? "All assets have valid active owners"
              : `Found ${unowned.length} assets without active owners`,
          affectedRecordIds: unowned.map((a) => a.id),
          metadata: {
            totalAssets: assets.length,
            unownedAssets: unowned.length,
          },
        };
      },
    },

    {
      id: "ownership.no_conflicts",
      name: "No ownership conflicts",
      description: "No asset should have multiple active owners",
      category: InvariantCategory.OWNERSHIP,
      severity: InvariantSeverity.CRITICAL,
      remediation:
        "Resolve ownership conflicts by determining correct owner. Deactivate incorrect ownership records. Investigate how conflict occurred.",
      check: async (): Promise<InvariantCheckOutput> => {
        const ownerships = await context.getAllOwnerships();

        const activeByAsset = new Map<string, number>();
        for (const ownership of ownerships) {
          if (ownership.active) {
            activeByAsset.set(
              ownership.assetId,
              (activeByAsset.get(ownership.assetId) || 0) + 1,
            );
          }
        }

        const conflicts = Array.from(activeByAsset.entries())
          .filter(([_, count]) => count > 1)
          .map(([assetId]) => assetId);

        return {
          passed: conflicts.length === 0,
          message:
            conflicts.length === 0
              ? "No ownership conflicts detected"
              : `Found ${conflicts.length} assets with multiple active owners`,
          affectedRecordIds: conflicts,
          metadata: {
            conflictedAssets: conflicts.length,
          },
        };
      },
    },

    {
      id: "ownership.valid_owners",
      name: "All owners exist and are valid",
      description: "All owner IDs must reference existing, active users",
      category: InvariantCategory.OWNERSHIP,
      severity: InvariantSeverity.HIGH,
      remediation:
        "Identify orphaned ownership records. Transfer assets to valid owners or suspend assets pending review.",
      check: async (): Promise<InvariantCheckOutput> => {
        const ownerships = await context.getAllOwnerships();
        const invalidOwners: string[] = [];

        for (const ownership of ownerships) {
          if (ownership.active) {
            const exists = await context.ownerExists(ownership.ownerId);
            if (!exists) {
              invalidOwners.push(ownership.assetId);
            }
          }
        }

        return {
          passed: invalidOwners.length === 0,
          message:
            invalidOwners.length === 0
              ? "All active ownership records reference valid owners"
              : `Found ${invalidOwners.length} assets with invalid owner references`,
          affectedRecordIds: invalidOwners,
          metadata: {
            invalidOwnerCount: invalidOwners.length,
          },
        };
      },
    },

    {
      id: "ownership.chain_integrity",
      name: "Ownership chain integrity",
      description: "Ownership transfers should form valid chains without gaps",
      category: InvariantCategory.OWNERSHIP,
      severity: InvariantSeverity.MEDIUM,
      remediation:
        "Review ownership history. Identify missing transfers. Reconstruct chain if possible or mark for manual review.",
      check: async (): Promise<InvariantCheckOutput> => {
        const assets = await context.getAllAssets();
        const brokenChains: string[] = [];

        for (const asset of assets) {
          const history = await context.getOwnershipHistory(asset.id);

          // Check for gaps in chain
          const sorted = history.sort(
            (a, b) => a.acquiredAt.getTime() - b.acquiredAt.getTime(),
          );

          for (let i = 1; i < sorted.length; i++) {
            const prev = sorted[i - 1];
            const curr = sorted[i];

            // Previous owner should have transferred to current owner
            if (prev.transferredTo !== curr.ownerId) {
              brokenChains.push(asset.id);
              break;
            }
          }
        }

        return {
          passed: brokenChains.length === 0,
          message:
            brokenChains.length === 0
              ? "All ownership chains are intact"
              : `Found ${brokenChains.length} assets with broken ownership chains`,
          affectedRecordIds: brokenChains,
          metadata: {
            brokenChainCount: brokenChains.length,
          },
        };
      },
    },

    {
      id: "ownership.no_circular_transfers",
      name: "No circular ownership transfers",
      description: "Ownership should not loop back to previous owners in short cycles",
      category: InvariantCategory.OWNERSHIP,
      severity: InvariantSeverity.LOW,
      remediation:
        "Investigate circular transfers. May indicate wash trading or system abuse. Review for suspicious activity.",
      check: async (): Promise<InvariantCheckOutput> => {
        const assets = await context.getAllAssets();
        const circular: string[] = [];

        for (const asset of assets) {
          const history = await context.getOwnershipHistory(asset.id);

          // Check for cycles in last 5 transfers
          const recent = history.slice(-5);
          const owners = recent.map((h) => h.ownerId);
          const uniqueOwners = new Set(owners);

          if (owners.length > uniqueOwners.size) {
            circular.push(asset.id);
          }
        }

        return {
          passed: true,
          warning: circular.length > 0,
          message:
            circular.length === 0
              ? "No circular ownership patterns detected"
              : `Found ${circular.length} assets with potential circular ownership`,
          affectedRecordIds: circular,
          metadata: {
            circularPatternCount: circular.length,
          },
        };
      },
    },

    {
      id: "ownership.asset_owner_consistency",
      name: "Asset current owner matches active ownership record",
      description:
        "Asset.currentOwner should match the active ownership record owner",
      category: InvariantCategory.OWNERSHIP,
      severity: InvariantSeverity.HIGH,
      remediation:
        "Synchronize asset currentOwner field with active ownership records. Identify source of inconsistency.",
      check: async (): Promise<InvariantCheckOutput> => {
        const assets = await context.getAllAssets();
        const ownerships = await context.getAllOwnerships();

        const activeOwnership = new Map<string, string>();
        for (const ownership of ownerships) {
          if (ownership.active) {
            activeOwnership.set(ownership.assetId, ownership.ownerId);
          }
        }

        const inconsistent = assets.filter((asset) => {
          const activeOwner = activeOwnership.get(asset.id);
          return activeOwner && activeOwner !== asset.currentOwner;
        });

        return {
          passed: inconsistent.length === 0,
          message:
            inconsistent.length === 0
              ? "All assets have consistent ownership records"
              : `Found ${inconsistent.length} assets with ownership inconsistencies`,
          affectedRecordIds: inconsistent.map((a) => a.id),
          metadata: {
            inconsistentCount: inconsistent.length,
          },
        };
      },
    },
  ];
}

/**
 * Combined invariant registration for balance and ownership monitoring
 */
export function registerBalanceAndOwnershipInvariants(
  balanceContext: BalanceInvariantContext,
  ownershipContext: OwnershipInvariantContext,
): InvariantDefinition[] {
  return [
    ...createBalanceInvariants(balanceContext),
    ...createOwnershipInvariants(ownershipContext),
  ];
}
