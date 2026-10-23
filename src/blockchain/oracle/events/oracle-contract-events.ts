import { scValToNative, StrKey, xdr } from "@stellar/stellar-sdk";

/*
 * Versioned schemas for the events the Trellis oracle contract publishes
 * (Trellis-contracts: contracts/oracle-contract/src/events.rs), and a
 * fail-closed decoder for them (#348).
 *
 * Every event is published as topics (Symbol "oracle", Symbol <kind>) with a
 * tuple (ScVal vec) as data. Contract releases may only APPEND data fields:
 * v2 of the submitter, price and staleness events appended `correlation_id`.
 * The decoder therefore accepts
 *   - every registered version, matched by exact arity and ScVal types;
 *   - a longer tuple whose prefix matches the newest version (a future
 *     append-only release), reporting the extra field count;
 *   - unknown kinds under the "oracle" namespace, which are ignored;
 * and rejects reordered, retyped or removed fields. See
 * docs/oracle-contract-event-compatibility.md.
 */

export const ORACLE_EVENT_NAMESPACE = "oracle";

/** Largest data tuple decoded; bounds per-event work on hostile input (#345). */
export const MAX_ORACLE_EVENT_DATA_FIELDS = 16;
/** Most contract events scanned for one transaction; submit_price emits a few. */
export const MAX_CONTRACT_EVENTS_PER_TRANSACTION = 100;

export type OracleEventFieldType = "address" | "symbol" | "i128" | "u64" | "u32";

export interface OracleEventField {
  name: string;
  type: OracleEventFieldType;
}

export interface OracleEventSchema {
  kind: string;
  version: number;
  fields: readonly OracleEventField[];
}

const SCVAL_TYPE: Record<OracleEventFieldType, string> = {
  address: "scvAddress",
  symbol: "scvSymbol",
  i128: "scvI128",
  u64: "scvU64",
  u32: "scvU32",
};

const field = (name: string, type: OracleEventFieldType): OracleEventField => ({
  name,
  type,
});
const CORRELATION_ID = field("correlation_id", "symbol");

function versions(
  kind: string,
  v1: OracleEventField[],
  appended: OracleEventField[][] = [],
): OracleEventSchema[] {
  const out: OracleEventSchema[] = [{ kind, version: 1, fields: v1 }];
  for (const extra of appended)
    out.push({
      kind,
      version: out.length + 1,
      fields: [...out[out.length - 1].fields, ...extra],
    });
  return out;
}

/**
 * Registered schemas, oldest version first. Each later version must extend the
 * previous one; `assertAppendOnly` (run by the compatibility spec) enforces it.
 */
export const ORACLE_CONTRACT_EVENT_SCHEMAS: Readonly<
  Record<string, readonly OracleEventSchema[]>
> = {
  sub_reg: versions(
    "sub_reg",
    [field("submitter", "address"), field("timestamp", "u64")],
    [[CORRELATION_ID]],
  ),
  sub_del: versions(
    "sub_del",
    [field("submitter", "address"), field("timestamp", "u64")],
    [[CORRELATION_ID]],
  ),
  price: versions(
    "price",
    [
      field("feed_id", "symbol"),
      field("price", "i128"),
      field("submitter", "address"),
      field("timestamp", "u64"),
    ],
    [[CORRELATION_ID]],
  ),
  stale: versions(
    "stale",
    [field("window_seconds", "u64"), field("timestamp", "u64")],
    [[CORRELATION_ID]],
  ),
  staked: versions("staked", [
    field("submitter", "address"),
    field("amount", "i128"),
    field("total_stake", "i128"),
    field("timestamp", "u64"),
  ]),
  slashed: versions("slashed", [
    field("submitter", "address"),
    field("penalty_amount", "i128"),
    field("remaining_stake", "i128"),
    field("reason", "symbol"),
    field("timestamp", "u64"),
  ]),
  unbond: versions("unbond", [
    field("submitter", "address"),
    field("amount", "i128"),
    field("unlock_time", "u64"),
    field("timestamp", "u64"),
  ]),
  withdrawn: versions("withdrawn", [
    field("submitter", "address"),
    field("amount", "i128"),
    field("timestamp", "u64"),
  ]),
};

export type OracleContractEventErrorCode =
  | "EVENT_TOPIC_MISMATCH"
  | "EVENT_SCHEMA_MISMATCH"
  | "EVENT_DATA_TOO_LARGE"
  | "EVENT_SCAN_LIMIT";

/** A known oracle event whose shape breaks every registered schema. Not retryable. */
export class OracleContractEventError extends Error {
  constructor(
    public readonly code: OracleContractEventErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OracleContractEventError";
  }
}

export type OracleEventValue = string | number;

export interface DecodedOracleEvent {
  status: "decoded";
  kind: string;
  schemaVersion: number;
  contractId: string;
  /** i128/u64 values are decimal strings so they stay exact in JSON. */
  fields: Record<string, OracleEventValue>;
  correlationId: string | null;
  /** Data fields beyond the newest known schema (a newer append-only release). */
  unknownTrailingFields: number;
}

export type IgnoredReason =
  | "non_contract_event"
  | "foreign_contract"
  | "not_oracle_namespace"
  | "unknown_kind";

export interface IgnoredOracleEvent {
  status: "ignored";
  reason: IgnoredReason;
}

export type OracleEventDecodeResult = DecodedOracleEvent | IgnoredOracleEvent;

function symbolOf(value: xdr.ScVal | undefined): string | null {
  return value?.type === "scvSymbol" ? value.sym.toString() : null;
}

function toValue(value: xdr.ScVal, type: OracleEventFieldType): OracleEventValue {
  const native = scValToNative(value);
  if (type === "u32") return Number(native);
  return String(native);
}

function matches(data: xdr.ScVal[], schema: OracleEventSchema): boolean {
  return schema.fields.every(
    (f, index) => data[index]?.type === SCVAL_TYPE[f.type],
  );
}

/**
 * Decodes one contract event. Events that are not ours (system/diagnostic
 * events, other contracts, other namespaces, unknown oracle kinds) are ignored;
 * an oracle event of a known kind that fits no schema throws, because silently
 * dropping it would hide a contract/API drift.
 */
export function decodeOracleContractEvent(
  event: xdr.ContractEvent,
  expectedContractId: string,
): OracleEventDecodeResult {
  if (event.type.name !== "contract")
    return { status: "ignored", reason: "non_contract_event" };
  const rawId = event.contractId?.value;
  const contractId = rawId ? StrKey.encodeContract(Buffer.from(rawId)) : null;
  // Authorization boundary: any contract can publish ("oracle", "price"), so
  // only events emitted by the configured oracle contract are trusted.
  if (contractId !== expectedContractId)
    return { status: "ignored", reason: "foreign_contract" };

  const body = event.body.v0;
  const topics = body.topics;
  if (symbolOf(topics[0]) !== ORACLE_EVENT_NAMESPACE)
    return { status: "ignored", reason: "not_oracle_namespace" };
  const kind = symbolOf(topics[1]);
  if (topics.length !== 2 || kind === null)
    throw new OracleContractEventError(
      "EVENT_TOPIC_MISMATCH",
      `Oracle event topics must be (Symbol "${ORACLE_EVENT_NAMESPACE}", Symbol kind); got ${topics.length} topic(s)`,
    );
  const schemas = ORACLE_CONTRACT_EVENT_SCHEMAS[kind];
  if (!schemas) return { status: "ignored", reason: "unknown_kind" };

  const value = body.data;
  if (value.type !== "scvVec")
    throw new OracleContractEventError(
      "EVENT_SCHEMA_MISMATCH",
      `Oracle "${kind}" event data must be a tuple, got ${value.type}`,
    );
  const data = value.vec ?? [];
  if (data.length > MAX_ORACLE_EVENT_DATA_FIELDS)
    throw new OracleContractEventError(
      "EVENT_DATA_TOO_LARGE",
      `Oracle "${kind}" event has ${data.length} data fields; the limit is ${MAX_ORACLE_EVENT_DATA_FIELDS}`,
    );

  const newest = schemas[schemas.length - 1];
  const schema = [...schemas]
    .reverse()
    .find(
      (candidate) =>
        (data.length === candidate.fields.length ||
          (candidate === newest && data.length > candidate.fields.length)) &&
        matches(data, candidate),
    );
  if (!schema)
    throw new OracleContractEventError(
      "EVENT_SCHEMA_MISMATCH",
      `Oracle "${kind}" event data (${data
        .map((item) => item.type)
        .join(", ")}) matches no registered schema version (${schemas
        .map((s) => `v${s.version}: ${s.fields.map((f) => f.type).join(", ")}`)
        .join("; ")})`,
    );

  const fields: Record<string, OracleEventValue> = {};
  schema.fields.forEach((f, index) => {
    fields[f.name] = toValue(data[index], f.type);
  });
  const correlationId =
    typeof fields.correlation_id === "string" ? fields.correlation_id : null;
  return {
    status: "decoded",
    kind,
    schemaVersion: schema.version,
    contractId,
    fields,
    correlationId,
    unknownTrailingFields: data.length - schema.fields.length,
  };
}

export interface OracleTransactionEvents {
  /** False when RPC returned no contract events (older RPC or protocol). */
  available: boolean;
  decoded: DecodedOracleEvent[];
  ignored: number;
}

/**
 * Decodes the per-operation contract events of one transaction
 * (`getTransaction().events.contractEventsXdr`). The scan is capped before any
 * event is decoded, so cost is O(MAX_CONTRACT_EVENTS_PER_TRANSACTION).
 */
export function decodeOracleTransactionEvents(
  contractEventsXdr: xdr.ContractEvent[][] | undefined,
  expectedContractId: string,
): OracleTransactionEvents {
  const operations = Array.isArray(contractEventsXdr) ? contractEventsXdr : [];
  let total = 0;
  for (const events of operations) total += events?.length ?? 0;
  if (total > MAX_CONTRACT_EVENTS_PER_TRANSACTION)
    throw new OracleContractEventError(
      "EVENT_SCAN_LIMIT",
      `Transaction has ${total} contract events; at most ${MAX_CONTRACT_EVENTS_PER_TRANSACTION} are scanned`,
    );
  const decoded: DecodedOracleEvent[] = [];
  let ignored = 0;
  for (const events of operations)
    for (const event of events ?? []) {
      const result = decodeOracleContractEvent(event, expectedContractId);
      if (result.status === "decoded") decoded.push(result);
      else ignored++;
    }
  return { available: total > 0, decoded, ignored };
}

/**
 * Throws unless every version of every kind extends the previous version's
 * fields unchanged. Guards the registry itself against an edit that would make
 * already-emitted events undecodable.
 */
export function assertAppendOnly(
  registry: Readonly<Record<string, readonly OracleEventSchema[]>> = ORACLE_CONTRACT_EVENT_SCHEMAS,
): void {
  for (const [kind, schemas] of Object.entries(registry)) {
    schemas.forEach((schema, index) => {
      if (schema.kind !== kind || schema.version !== index + 1)
        throw new Error(`${kind}: versions must be numbered 1..n in order`);
      if (index === 0) return;
      const previous = schemas[index - 1].fields;
      const prefixKept = previous.every(
        (f, i) =>
          schema.fields[i]?.name === f.name && schema.fields[i]?.type === f.type,
      );
      if (!prefixKept || schema.fields.length <= previous.length)
        throw new Error(
          `${kind} v${schema.version} must append fields to v${schema.version - 1} without changing it`,
        );
    });
  }
}
