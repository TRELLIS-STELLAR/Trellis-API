import {
  Account,
  Address,
  Contract,
  Keypair,
  Networks,
  nativeToScVal,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { hashOracleArguments } from "src/blockchain/oracle/services/stellar-oracle.adapter";

/** Public test identity only; never fund or use this deterministic key on-chain. */
export const LEDGER_FIXTURE_SUBMITTER = Keypair.fromRawEd25519Seed(
  Buffer.alloc(32, 42),
).publicKey();
export const LEDGER_FIXTURE_CONTRACT = StrKey.encodeContract(
  Buffer.alloc(32, 1),
);

/** Fixed time bounds and account sequence make XDR and hashes replayable. */
export function createLedgerSequenceFixture() {
  const args = [
    new Address(LEDGER_FIXTURE_SUBMITTER).toScVal(),
    nativeToScVal("XLM_USD", { type: "symbol" }),
    nativeToScVal(100n, { type: "i128" }),
    nativeToScVal(2, { type: "u32" }),
    nativeToScVal(1700000000n, { type: "u64" }),
    nativeToScVal(1n, { type: "u64" }),
  ];
  const transaction = new TransactionBuilder(
    new Account(LEDGER_FIXTURE_SUBMITTER, "429496729600"),
    { fee: "100", networkPassphrase: Networks.TESTNET },
  )
    .addOperation(
      new Contract(LEDGER_FIXTURE_CONTRACT).call("submit_price", ...args),
    )
    .setTimebounds(1700000000, 1700000030)
    .build();
  return {
    transaction,
    submission: {
      submitter: LEDGER_FIXTURE_SUBMITTER,
      payloadHash: hashOracleArguments(args),
      transactionHash: Buffer.from(transaction.hash()).toString("hex"),
    },
  };
}

/** Ledger inclusion counts as the first confirmation. Max is Stellar uint32. */
export const CONFIRMATION_FIXTURES = [
  { name: "first ledger", ledger: 1, latest: 1, minimum: 1, confirmed: true },
  {
    name: "inclusion ledger",
    ledger: 100,
    latest: 100,
    minimum: 2,
    confirmed: false,
  },
  {
    name: "exact threshold",
    ledger: 100,
    latest: 101,
    minimum: 2,
    confirmed: true,
  },
  {
    name: "above threshold",
    ledger: 100,
    latest: 102,
    minimum: 2,
    confirmed: true,
  },
  {
    name: "stale RPC head",
    ledger: 100,
    latest: 99,
    minimum: 1,
    confirmed: false,
  },
  {
    name: "uint32 boundary pending",
    ledger: 4294967294,
    latest: 4294967294,
    minimum: 2,
    confirmed: false,
  },
  {
    name: "uint32 boundary confirmed",
    ledger: 4294967294,
    latest: 4294967295,
    minimum: 2,
    confirmed: true,
  },
] as const;

export const LEDGER_TTL_FIXTURES = [
  {
    name: "before expiry",
    latest: 99,
    ttl: 100,
    temporary: false,
    expected: "live",
  },
  {
    name: "expiry ledger inclusive",
    latest: 100,
    ttl: 100,
    temporary: false,
    expected: "live",
  },
  {
    name: "persistent expired",
    latest: 101,
    ttl: 100,
    temporary: false,
    expected: "archived",
  },
  {
    name: "temporary expired",
    latest: 101,
    ttl: 100,
    temporary: true,
    expected: "missing",
  },
  {
    name: "archived placeholder",
    latest: 100,
    ttl: 0,
    temporary: false,
    expected: "archived",
  },
  {
    name: "maximum live ledger",
    latest: 4294967295,
    ttl: 4294967295,
    temporary: false,
    expected: "live",
  },
] as const;
