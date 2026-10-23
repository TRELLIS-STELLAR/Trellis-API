import { Address, nativeToScVal, StrKey, xdr } from "@stellar/stellar-sdk";
import {
  ORACLE_CONTRACT_EVENT_SCHEMAS,
  OracleContractEventError,
  OracleEventSchema,
  assertAppendOnly,
  decodeOracleContractEvent,
  decodeOracleTransactionEvents,
} from "./oracle-contract-events";
import golden from "./__fixtures__/oracle-contract-events.v1-v2.json";

/**
 * Compatibility of the API's oracle event decoder with every event shape the
 * oracle contract has published (#348). The golden XDR is frozen: if a decoder
 * change cannot read it, that change breaks already-emitted ledger history.
 */

const { contractId, submitter } = golden;
const sym = (value: string) => nativeToScVal(value, { type: "symbol" });
const i128 = (value: bigint) => nativeToScVal(value, { type: "i128" });
const u64 = (value: bigint) => nativeToScVal(value, { type: "u64" });
const address = () => new Address(submitter).toScVal();

function contractEvent(
  topics: xdr.ScVal[],
  data: xdr.ScVal,
  options: { contract?: string | null; type?: xdr.ContractEventType } = {},
) {
  const emitter = options.contract === undefined ? contractId : options.contract;
  return new xdr.ContractEvent({
    ext: xdr.ExtensionPoint.v0(),
    contractId: emitter ? new xdr.ContractId(StrKey.decodeContract(emitter)) : null,
    type: options.type ?? xdr.ContractEventType.contract,
    body: xdr.ContractEventBody.v0(new xdr.ContractEventV0({ topics, data })),
  });
}
const oracle = (kind: string, data: xdr.ScVal[], options = {}) =>
  contractEvent([sym("oracle"), sym(kind)], xdr.ScVal.scvVec(data), options);
const PRICE_V2 = () => [sym("XLM_USD"), i128(5n), address(), u64(1n), sym("req_1")];

describe("oracle contract event schema compatibility (#348)", () => {
  describe("schema registry", () => {
    it("is append-only for every event kind", () => {
      expect(() => assertAppendOnly()).not.toThrow();
    });

    const mutate = (fields: OracleEventSchema["fields"]) => ({
      price: [
        ORACLE_CONTRACT_EVENT_SCHEMAS.price[0],
        { kind: "price", version: 2, fields },
      ],
    });
    const v1 = ORACLE_CONTRACT_EVENT_SCHEMAS.price[0].fields;

    it.each([
      ["reordered", [v1[1], v1[0], ...v1.slice(2), { name: "x", type: "symbol" }]],
      ["retyped", [{ ...v1[0], type: "u64" }, ...v1.slice(1), { name: "x", type: "symbol" }]],
      ["removed", v1.slice(0, 3)],
      ["unchanged", [...v1]],
    ])("rejects a %s v2", (_label, fields) => {
      expect(() => assertAppendOnly(mutate(fields as any))).toThrow(/must append/);
    });

    it("covers every kind present in the golden corpus", () => {
      const kinds = new Set(golden.events.map((e) => e.kind));
      expect([...kinds].sort()).toEqual(Object.keys(ORACLE_CONTRACT_EVENT_SCHEMAS).sort());
    });
  });

  describe("normal path: every published shape decodes from frozen XDR", () => {
    it.each(golden.events.map((e) => [`${e.kind} v${e.version}`, e]))(
      "%s",
      (_label, fixture: (typeof golden.events)[number]) => {
        const event = xdr.ContractEvent.fromXdr(fixture.xdr, "base64");
        expect(decodeOracleContractEvent(event, contractId)).toEqual({
          status: "decoded",
          kind: fixture.kind,
          schemaVersion: fixture.version,
          contractId,
          fields: fixture.fields,
          correlationId: (fixture.fields as Record<string, string>).correlation_id ?? null,
          unknownTrailingFields: 0,
        });
      },
    );

    it("keeps i128 prices exact beyond Number.MAX_SAFE_INTEGER", () => {
      const huge = 2n ** 100n;
      const decoded = decodeOracleContractEvent(
        oracle("price", [sym("BTC_USD"), i128(huge), address(), u64(1n)]),
        contractId,
      );
      expect(decoded).toMatchObject({ fields: { price: huge.toString() } });
    });

    it("accepts a future append-only release and reports the extra fields", () => {
      const decoded = decodeOracleContractEvent(
        oracle("price", [...PRICE_V2(), u64(42n), sym("extra")]),
        contractId,
      );
      expect(decoded).toMatchObject({
        status: "decoded",
        schemaVersion: 2,
        correlationId: "req_1",
        unknownTrailingFields: 2,
      });
    });
  });

  describe("failure path: breaking shapes fail closed", () => {
    it.each([
      ["reordered fields", oracle("price", [i128(5n), sym("XLM_USD"), address(), u64(1n)])],
      ["retyped price", oracle("price", [sym("XLM_USD"), u64(5n), address(), u64(1n)])],
      ["removed field", oracle("price", [sym("XLM_USD"), i128(5n), address()])],
      ["v1 prefix with a wrong appended type", oracle("price", [sym("XLM_USD"), i128(5n), address(), u64(1n), u64(9n)])],
      ["non-tuple data", contractEvent([sym("oracle"), sym("price")], sym("XLM_USD"))],
    ])("%s", (_label, event) => {
      expect(() => decodeOracleContractEvent(event, contractId)).toThrow(
        expect.objectContaining({ code: "EVENT_SCHEMA_MISMATCH" }),
      );
    });

    it("rejects a malformed oracle topic list", () => {
      const event = contractEvent(
        [sym("oracle"), sym("price"), sym("extra")],
        xdr.ScVal.scvVec(PRICE_V2()),
      );
      expect(() => decodeOracleContractEvent(event, contractId)).toThrow(
        expect.objectContaining({ code: "EVENT_TOPIC_MISMATCH" }),
      );
    });

    it("names the expected versions in the error to speed up triage", () => {
      try {
        decodeOracleContractEvent(oracle("stale", [sym("x")]), contractId);
        fail("expected a schema error");
      } catch (error) {
        expect(error).toBeInstanceOf(OracleContractEventError);
        expect(error.message).toContain("v1: u64, u64; v2: u64, u64, symbol");
      }
    });
  });

  describe("authorization path: only the configured oracle contract is trusted", () => {
    const other = StrKey.encodeContract(Buffer.alloc(32, 8));

    it.each([
      ["another contract emitting an oracle-shaped event", oracle("price", PRICE_V2(), { contract: other }), "foreign_contract"],
      ["an event without an emitter", oracle("price", PRICE_V2(), { contract: null }), "foreign_contract"],
      ["a system event", oracle("price", PRICE_V2(), { type: xdr.ContractEventType.system }), "non_contract_event"],
      ["a diagnostic event", oracle("price", PRICE_V2(), { type: xdr.ContractEventType.diagnostic }), "non_contract_event"],
      ["another namespace", contractEvent([sym("token"), sym("price")], xdr.ScVal.scvVec(PRICE_V2())), "not_oracle_namespace"],
      ["a kind added by a newer contract", oracle("paused", [u64(1n)]), "unknown_kind"],
    ])("ignores %s", (_label, event, reason) => {
      expect(decodeOracleContractEvent(event, contractId)).toEqual({
        status: "ignored",
        reason,
      });
    });

    it("does not throw on a malformed event from a foreign contract", () => {
      const junk = contractEvent([sym("oracle"), sym("price"), sym("x")], sym("junk"), { contract: other });
      expect(decodeOracleContractEvent(junk, contractId).status).toBe("ignored");
    });
  });

  describe("retry path: decoding is deterministic and replay-safe", () => {
    it("re-decoding the same ledger event yields an identical result", () => {
      const fixture = golden.events.find((e) => e.kind === "price" && e.version === 2);
      const results = [1, 2, 3].map(() =>
        decodeOracleContractEvent(xdr.ContractEvent.fromXdr(fixture.xdr, "base64"), contractId),
      );
      expect(results[1]).toEqual(results[0]);
      expect(results[2]).toEqual(results[0]);
    });

    it("scans per-operation events, counting ignored ones", () => {
      const result = decodeOracleTransactionEvents(
        [
          [oracle("price", PRICE_V2())],
          [oracle("paused", [u64(1n)]), oracle("price", PRICE_V2(), { contract: StrKey.encodeContract(Buffer.alloc(32, 3)) })],
        ],
        contractId,
      );
      expect(result.available).toBe(true);
      expect(result.decoded.map((e) => e.kind)).toEqual(["price"]);
      expect(result.ignored).toBe(2);
    });

    it.each([[undefined], [[]], [[[]]]])("treats %p as events unavailable", (events) => {
      expect(decodeOracleTransactionEvents(events as any, contractId)).toEqual({
        available: false,
        decoded: [],
        ignored: 0,
      });
    });
  });
});
