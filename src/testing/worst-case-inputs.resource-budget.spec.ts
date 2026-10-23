import { Address, nativeToScVal, StrKey, xdr } from "@stellar/stellar-sdk";
import {
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_OBJECT_KEYS,
  MAX_STRING_LENGTH,
  REDACTED,
  TRUNCATED_KEYS_FIELD,
  sanitizeErrorMessage,
  sanitizeObject,
  sanitizeUrl,
  sanitizeValue,
} from "../logging/sanitize.util";
import { MAX_REDACTION_DEPTH, redactSensitive } from "../common/redaction";
import {
  MAX_CORRELATION_ID_LENGTH,
  normalizeCorrelationId,
  resolveInboundCorrelationId,
} from "../common/correlation/correlation-context";
import {
  MAX_CONTRACT_EVENTS_PER_TRANSACTION,
  MAX_ORACLE_EVENT_DATA_FIELDS,
  decodeOracleContractEvent,
  decodeOracleTransactionEvents,
} from "../blockchain/oracle/events/oracle-contract-events";

/**
 * Resource budget regression checks for worst-case inputs (#345).
 *
 * Each case feeds a hostile or pathological input to a code path that sits on
 * a request, log, worker or ledger-verification hot path and asserts a
 * deterministic ceiling on work (property reads, decoded elements) and output
 * size. Ceilings are the exported constants, so changing a limit means
 * changing it here and in docs/resource-budget-tests.md together.
 */

/** Object whose property reads are counted, to prove values are not visited. */
function countingObject(keys: number) {
  const counter = { reads: 0 };
  const target: Record<string, unknown> = {};
  for (let i = 0; i < keys; i++)
    Object.defineProperty(target, `k${i}`, {
      enumerable: true,
      get: () => {
        counter.reads++;
        return i;
      },
    });
  return { target, counter };
}

function deepObject(depth: number) {
  const root: Record<string, unknown> = {};
  let node = root;
  for (let i = 0; i < depth; i++) {
    const child: Record<string, unknown> = {};
    node.child = child;
    node = child;
  }
  node.password = "leaf-secret";
  return root;
}

function outputDepth(value: unknown): number {
  let depth = 0;
  let node: any = value;
  while (node && typeof node === "object" && node.child !== undefined) {
    depth++;
    node = node.child;
  }
  return depth;
}

describe("worst-case input resource budgets (#345)", () => {
  describe("log sanitisation (every HTTP request body and log line)", () => {
    it(`visits at most ${MAX_OBJECT_KEYS} values of a 50,000-key object`, () => {
      const { target, counter } = countingObject(50_000);
      const out = sanitizeObject(target);
      expect(counter.reads).toBeLessThanOrEqual(MAX_OBJECT_KEYS);
      expect(Object.keys(out)).toHaveLength(MAX_OBJECT_KEYS + 1);
      expect(out[TRUNCATED_KEYS_FIELD]).toBe(50_000 - MAX_OBJECT_KEYS);
    });

    it("still redacts sensitive keys inside the kept window", () => {
      const out = sanitizeObject({ password: "p", ...Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`f${i}`, i])) });
      expect(out.password).toBe(REDACTED);
    });

    it("reads at most 50 elements of a 1,000,000-element array", () => {
      let reads = 0;
      const huge = new Proxy(new Array(1_000_000).fill(1), {
        get(target, prop, receiver) {
          if (typeof prop === "string" && /^\d+$/.test(prop)) reads++;
          return Reflect.get(target, prop, receiver);
        },
      });
      const out = sanitizeValue(huge) as unknown[];
      expect(out).toHaveLength(50);
      expect(reads).toBeLessThanOrEqual(50);
    });

    it("collapses 10,000 levels of nesting without exhausting the stack", () => {
      const out = sanitizeValue(deepObject(10_000));
      expect(outputDepth(out)).toBeLessThanOrEqual(9);
      expect(JSON.stringify(out).length).toBeLessThan(200);
    });

    it(`caps a 5 MB string value at ${MAX_STRING_LENGTH} characters`, () => {
      const out = sanitizeValue("a".repeat(5 * 1024 * 1024)) as string;
      expect(out.length).toBeLessThan(MAX_STRING_LENGTH + 64);
      expect(out).toMatch(/\[TRUNCATED \d+ chars\]$/);
    });

    it.each([
      ["repeated credential pairs", "password=x ".repeat(500_000)],
      ["one unbroken hex run", "a".repeat(5_000_000)],
      ["near-miss JWT fragments", "eyJ.".repeat(1_000_000)],
      ["near-miss Stellar seeds", ("S" + "A".repeat(54) + " ").repeat(100_000)],
    ])(`bounds error-message output for %s`, (_label, input) => {
      const out = sanitizeErrorMessage(input);
      expect(out.length).toBeLessThan(MAX_ERROR_MESSAGE_LENGTH + 64);
    });

    it("never keeps the visible half of a secret cut by the length cap", () => {
      const jwt =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
      for (const offset of [5, 20, 40, 60]) {
        const pad = "x".repeat(MAX_ERROR_MESSAGE_LENGTH - offset);
        const out = sanitizeErrorMessage(`${pad} ${jwt} trailing`);
        expect(out).not.toContain(jwt.slice(0, 12));
        expect(out.length).toBeLessThan(MAX_ERROR_MESSAGE_LENGTH + 64);
      }
    });

    it("bounds URL sanitisation of a 1 MB query string", () => {
      const url = "/api/v1/search?" + "token=t&".repeat(150_000);
      const out = sanitizeUrl(url);
      expect(out.length).toBeLessThan(MAX_STRING_LENGTH * 4);
      expect(out).not.toMatch(/token=t(&|$)/);
    });
  });

  describe("telemetry redaction", () => {
    it(`stops at depth ${MAX_REDACTION_DEPTH} on 100,000 levels instead of overflowing the stack`, () => {
      const out = redactSensitive(deepObject(100_000));
      expect(outputDepth(out)).toBeLessThanOrEqual(MAX_REDACTION_DEPTH);
      expect(JSON.stringify(out)).not.toContain("leaf-secret");
    });
  });

  describe("request correlation header (every inbound request)", () => {
    it("rejects a 16 MB header without scanning it", () => {
      const header = "a".repeat(16 * 1024 * 1024);
      expect(normalizeCorrelationId(header)).toBeNull();
      const resolved = resolveInboundCorrelationId({ "x-correlation-id": header });
      expect(resolved.correlationId.length).toBeLessThanOrEqual(MAX_CORRELATION_ID_LENGTH);
      expect(resolved.rejected).toBe(true);
    });

    it("uses only the first value of a 10,000-value repeated header", () => {
      const values = Array.from({ length: 10_000 }, (_, i) => `id-${i}`);
      expect(normalizeCorrelationId(values)).toBe("id-0");
    });
  });

  describe("oracle contract event verification (per ledger transaction)", () => {
    const contractId = StrKey.encodeContract(Buffer.alloc(32, 5));
    const sym = (value: string) => nativeToScVal(value, { type: "symbol" });

    it(`refuses ${MAX_CONTRACT_EVENTS_PER_TRANSACTION * 100} events before decoding any of them`, () => {
      let touched = 0;
      const event = new Proxy({} as xdr.ContractEvent, {
        get() {
          touched++;
          return undefined;
        },
      });
      const flood = [Array.from({ length: MAX_CONTRACT_EVENTS_PER_TRANSACTION * 100 }, () => event)];
      expect(() => decodeOracleTransactionEvents(flood, contractId)).toThrow(
        expect.objectContaining({ code: "EVENT_SCAN_LIMIT" }),
      );
      expect(touched).toBe(0);
    });

    it(`decodes exactly ${MAX_CONTRACT_EVENTS_PER_TRANSACTION} events at the limit`, () => {
      const foreign = new xdr.ContractEvent({
        ext: xdr.ExtensionPoint.v0(),
        contractId: new xdr.ContractId(Buffer.alloc(32, 6)),
        type: xdr.ContractEventType.contract,
        body: xdr.ContractEventBody.v0(new xdr.ContractEventV0({ topics: [sym("oracle")], data: sym("x") })),
      });
      const result = decodeOracleTransactionEvents(
        [Array.from({ length: MAX_CONTRACT_EVENTS_PER_TRANSACTION }, () => foreign)],
        contractId,
      );
      expect(result.ignored).toBe(MAX_CONTRACT_EVENTS_PER_TRANSACTION);
    });

    it("refuses a 10,000-field event tuple without inspecting its elements", () => {
      const submitter = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 4));
      const fields = Array.from({ length: 10_000 }, () => new Address(submitter).toScVal());
      let elementReads = 0;
      const counted = new Proxy(fields, {
        get(target, prop, receiver) {
          if (typeof prop === "string" && /^\d+$/.test(prop)) elementReads++;
          return Reflect.get(target, prop, receiver);
        },
      });
      const event = new xdr.ContractEvent({
        ext: xdr.ExtensionPoint.v0(),
        contractId: new xdr.ContractId(StrKey.decodeContract(contractId)),
        type: xdr.ContractEventType.contract,
        body: xdr.ContractEventBody.v0(
          new xdr.ContractEventV0({ topics: [sym("oracle"), sym("price")], data: xdr.ScVal.scvVec(fields) }),
        ),
      });
      Object.defineProperty(event.body.v0.data, "vec", { value: counted });
      expect(() => decodeOracleContractEvent(event, contractId)).toThrow(
        expect.objectContaining({ code: "EVENT_DATA_TOO_LARGE" }),
      );
      expect(elementReads).toBe(0);
      expect(MAX_ORACLE_EVENT_DATA_FIELDS).toBeLessThan(10_000);
    });
  });
});
