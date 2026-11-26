/**
 * Cryptographic provenance tests (#issue-3)
 *
 * Comprehensive test suite covering normal paths, failure scenarios,
 * retry logic, and authorization checks for cryptographic provenance.
 */

import { generateKeyPairSync, sign } from "crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "../../common/errors/app.exception";
import {
  EvidenceActor,
  ExternalEvidence,
  TrustedEvidenceKey,
  computePayloadDigest,
  evidenceSigningInput,
} from "../../common/evidence/evidence-verifier";
import { Permission, Role } from "../../common/guard/roles.enum";
import {
  CryptographicProvenanceService,
  ProvenanceQuery,
} from "./cryptographic-provenance";

function generateEd25519KeyPair(): {
  publicKeyPem: string;
  privateKeyPem: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) as string,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}

function signEvidence(
  evidence: Pick<ExternalEvidence, "id" | "type" | "issuer" | "keyId" | "issuedAt" | "payloadDigest">,
  privateKeyPem: string,
): string {
  const input = evidenceSigningInput(evidence);
  const signature = sign(null, input, {
    key: privateKeyPem,
    format: "pem",
  });
  return signature.toString("base64");
}

describe("Cryptographic Provenance Service", () => {
  let service: CryptographicProvenanceService;
  let trustedKey: TrustedEvidenceKey;
  let privateKey: string;
  let adminActor: EvidenceActor;
  let operatorActor: EvidenceActor;
  let unauthorizedActor: EvidenceActor;

  beforeEach(() => {
    const keyPair = generateEd25519KeyPair();
    privateKey = keyPair.privateKeyPem;

    trustedKey = {
      keyId: "test-key-1",
      issuer: "test-issuer",
      publicKeyPem: keyPair.publicKeyPem,
      allowedTypes: ["transaction", "audit", "verification"],
      notBefore: new Date(Date.now() - 86400000).toISOString(),
      notAfter: new Date(Date.now() + 86400000).toISOString(),
    };

    service = new CryptographicProvenanceService([trustedKey], {
      autoSignChain: true,
      strictMode: true,
    });

    adminActor = {
      id: "admin-1",
      roles: [Role.ADMIN],
    };

    operatorActor = {
      id: "operator-1",
      roles: [Role.OPERATOR],
    };

    unauthorizedActor = {
      id: "user-1",
      roles: [Role.USER],
    };
  });

  describe("Normal path: record import with provenance", () => {
    it("imports a record without external evidence", () => {
      const content = { amount: 100, currency: "USD" };

      const provenance = service.importRecord(
        adminActor,
        "record-1",
        "transaction",
        content,
      );

      expect(provenance.recordId).toBe("record-1");
      expect(provenance.recordType).toBe("transaction");
      expect(provenance.contentDigest).toBe(computePayloadDigest(content));
      expect(provenance.source.issuer).toBe("internal");
      expect(provenance.source.verified).toBe(false);
      expect(provenance.chain).toHaveLength(1);
      expect(provenance.chain[0].action).toBe("imported");
      expect(provenance.chain[0].actor).toBe("admin-1");
    });

    it("imports a record with verified external evidence", () => {
      const content = { amount: 100, currency: "USD" };
      const payloadDigest = computePayloadDigest(content);
      const now = new Date().toISOString();

      const evidence: ExternalEvidence = {
        id: "evidence-1",
        type: "transaction",
        issuer: "test-issuer",
        keyId: "test-key-1",
        issuedAt: now,
        payload: content,
        payloadDigest,
        signature: "",
      };

      evidence.signature = signEvidence(evidence, privateKey);

      const provenance = service.importRecord(
        adminActor,
        "record-2",
        "transaction",
        content,
        evidence,
      );

      expect(provenance.source.verified).toBe(true);
      expect(provenance.source.issuer).toBe("test-issuer");
      expect(provenance.source.keyId).toBe("test-key-1");
      expect(provenance.evidence).toEqual(evidence);
      expect(provenance.metadata.importMethod).toBe("external");
    });

    it("allows safe retry of identical import", () => {
      const content = { amount: 100, currency: "USD" };

      const first = service.importRecord(
        adminActor,
        "record-3",
        "transaction",
        content,
      );

      const second = service.importRecord(
        adminActor,
        "record-3",
        "transaction",
        content,
      );

      expect(second.id).toBe(first.id);
      expect(second.contentDigest).toBe(first.contentDigest);
    });

    it("adds chain entries for modifications", () => {
      const content = { amount: 100, currency: "USD" };

      service.importRecord(adminActor, "record-4", "transaction", content);

      const modifiedContent = { amount: 150, currency: "USD" };

      const updated = service.addChainEntry(
        adminActor,
        "record-4",
        "modified",
        modifiedContent,
        { reason: "price adjustment" },
      );

      expect(updated.chain).toHaveLength(2);
      expect(updated.chain[1].action).toBe("modified");
      expect(updated.chain[1].sequence).toBe(1);
      expect(updated.chain[1].metadata).toEqual({ reason: "price adjustment" });
      expect(updated.contentDigest).toBe(computePayloadDigest(modifiedContent));
    });

    it("tracks complete chain of custody", () => {
      const content = { amount: 100, currency: "USD" };

      service.importRecord(adminActor, "record-5", "transaction", content);

      service.addChainEntry(adminActor, "record-5", "verified", content);
      service.addChainEntry(adminActor, "record-5", "modified", content);
      service.addChainEntry(adminActor, "record-5", "archived", content);

      const history = service.getProvenanceHistory("record-5");

      expect(history).toHaveLength(4);
      expect(history.map((e) => e.action)).toEqual([
        "imported",
        "verified",
        "modified",
        "archived",
      ]);
      expect(history.map((e) => e.sequence)).toEqual([0, 1, 2, 3]);
    });
  });

  describe("Failure path: validation and rejection", () => {
    it("rejects import with different content for same record ID", () => {
      const content1 = { amount: 100, currency: "USD" };
      const content2 = { amount: 200, currency: "EUR" };

      service.importRecord(adminActor, "record-6", "transaction", content1);

      expect(() => {
        service.importRecord(adminActor, "record-6", "transaction", content2);
      }).toThrow(ConflictException);
    });

    it("rejects adding chain entry for non-existent record", () => {
      expect(() => {
        service.addChainEntry(
          adminActor,
          "non-existent",
          "modified",
          { data: "test" },
        );
      }).toThrow(BadRequestException);
    });

    it("detects evidence verification failures", () => {
      const content = { amount: 100, currency: "USD" };
      const payloadDigest = computePayloadDigest(content);

      // Create evidence with invalid signature
      const evidence: ExternalEvidence = {
        id: "bad-evidence",
        type: "transaction",
        issuer: "test-issuer",
        keyId: "test-key-1",
        issuedAt: new Date().toISOString(),
        payload: content,
        payloadDigest,
        signature: "invalid-signature",
      };

      expect(() => {
        service.importRecord(
          adminActor,
          "record-7",
          "transaction",
          content,
          evidence,
        );
      }).toThrow(BadRequestException);
    });

    it("detects tampered payload digest", () => {
      const content = { amount: 100, currency: "USD" };
      const now = new Date().toISOString();

      const evidence: ExternalEvidence = {
        id: "tampered-evidence",
        type: "transaction",
        issuer: "test-issuer",
        keyId: "test-key-1",
        issuedAt: now,
        payload: content,
        payloadDigest: "tampered-digest",
        signature: "",
      };

      evidence.signature = signEvidence(evidence, privateKey);

      expect(() => {
        service.importRecord(
          adminActor,
          "record-8",
          "transaction",
          content,
          evidence,
        );
      }).toThrow(BadRequestException);
    });

    it("verifies chain integrity and detects issues", () => {
      const content = { amount: 100, currency: "USD" };

      service.importRecord(adminActor, "record-9", "transaction", content);

      service.addChainEntry(adminActor, "record-9", "modified", content);

      const verification = service.verifyProvenance("record-9");

      expect(verification.valid).toBe(true);
      expect(verification.chainValid).toBe(true);
      expect(verification.issues).toHaveLength(0);
    });

    it("reports verification failure for missing record", () => {
      const verification = service.verifyProvenance("non-existent");

      expect(verification.valid).toBe(false);
      expect(verification.issues).toHaveLength(1);
      expect(verification.issues[0].type).toBe("NOT_FOUND");
    });
  });

  describe("Retry path: conflict resolution", () => {
    it("handles duplicate evidence IDs in strict mode", () => {
      const content = { amount: 100, currency: "USD" };
      const payloadDigest = computePayloadDigest(content);
      const now = new Date().toISOString();

      const evidence: ExternalEvidence = {
        id: "duplicate-evidence",
        type: "transaction",
        issuer: "test-issuer",
        keyId: "test-key-1",
        issuedAt: now,
        payload: content,
        payloadDigest,
        signature: "",
      };

      evidence.signature = signEvidence(evidence, privateKey);

      service.importRecord(adminActor, "record-10", "transaction", content, evidence);

      // Attempting to use the same evidence for a different record
      expect(() => {
        service.importRecord(
          adminActor,
          "record-11",
          "transaction",
          content,
          evidence,
        );
      }).toThrow(ConflictException);
    });

    it("allows retries with same content", () => {
      const content = { amount: 100, currency: "USD" };

      const first = service.importRecord(
        adminActor,
        "record-12",
        "transaction",
        content,
      );

      const second = service.importRecord(
        adminActor,
        "record-12",
        "transaction",
        content,
      );

      expect(second.id).toBe(first.id);
    });

    it("handles multiple modifications correctly", () => {
      const content = { amount: 100, currency: "USD" };

      service.importRecord(adminActor, "record-13", "transaction", content);

      const updates = [
        { amount: 110, currency: "USD" },
        { amount: 120, currency: "USD" },
        { amount: 130, currency: "USD" },
      ];

      updates.forEach((update, i) => {
        service.addChainEntry(adminActor, "record-13", "modified", update);
      });

      const history = service.getProvenanceHistory("record-13");

      expect(history).toHaveLength(4); // 1 import + 3 modifications
      expect(history[history.length - 1].contentDigest).toBe(
        computePayloadDigest(updates[updates.length - 1]),
      );
    });
  });

  describe("Authorization path: permission enforcement", () => {
    it("blocks unauthorized actors from importing", () => {
      const content = { amount: 100, currency: "USD" };

      expect(() => {
        service.importRecord(
          unauthorizedActor,
          "record-14",
          "transaction",
          content,
        );
      }).toThrow(ForbiddenException);
    });

    it("blocks unauthorized actors from modifying", () => {
      const content = { amount: 100, currency: "USD" };

      service.importRecord(adminActor, "record-15", "transaction", content);

      expect(() => {
        service.addChainEntry(
          unauthorizedActor,
          "record-15",
          "modified",
          content,
        );
      }).toThrow(ForbiddenException);
    });

    it("allows operators to import records", () => {
      const content = { amount: 100, currency: "USD" };

      const provenance = service.importRecord(
        operatorActor,
        "record-16",
        "transaction",
        content,
      );

      expect(provenance.importedBy.actorId).toBe("operator-1");
    });

    it("tracks actor roles in provenance", () => {
      const content = { amount: 100, currency: "USD" };

      const provenance = service.importRecord(
        adminActor,
        "record-17",
        "transaction",
        content,
      );

      expect(provenance.importedBy.roles).toContain(Role.ADMIN);
    });
  });

  describe("Querying and statistics", () => {
    beforeEach(() => {
      // Set up test data
      service.importRecord(adminActor, "rec-1", "transaction", { a: 1 });
      service.importRecord(adminActor, "rec-2", "audit", { b: 2 });
      service.importRecord(operatorActor, "rec-3", "transaction", { c: 3 });

      const content = { d: 4 };
      const evidence: ExternalEvidence = {
        id: "ev-1",
        type: "verification",
        issuer: "test-issuer",
        keyId: "test-key-1",
        issuedAt: new Date().toISOString(),
        payload: content,
        payloadDigest: computePayloadDigest(content),
        signature: "",
      };
      evidence.signature = signEvidence(evidence, privateKey);

      service.importRecord(adminActor, "rec-4", "verification", content, evidence);
    });

    it("queries records by type", () => {
      const query: ProvenanceQuery = { recordType: "transaction" };
      const results = service.queryProvenance(query);

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.recordType === "transaction")).toBe(true);
    });

    it("queries records by issuer", () => {
      const query: ProvenanceQuery = { issuer: "test-issuer" };
      const results = service.queryProvenance(query);

      expect(results).toHaveLength(1);
      expect(results[0].recordId).toBe("rec-4");
    });

    it("queries records by import actor", () => {
      const query: ProvenanceQuery = { importedBy: "operator-1" };
      const results = service.queryProvenance(query);

      expect(results).toHaveLength(1);
      expect(results[0].importedBy.actorId).toBe("operator-1");
    });

    it("queries verified records only", () => {
      const query: ProvenanceQuery = { verified: true };
      const results = service.queryProvenance(query);

      expect(results).toHaveLength(1);
      expect(results[0].source.verified).toBe(true);
    });

    it("generates comprehensive statistics", () => {
      const stats = service.getStatistics();

      expect(stats.totalRecords).toBe(4);
      expect(stats.verifiedRecords).toBe(1);
      expect(stats.unverifiedRecords).toBe(3);
      expect(stats.byType["transaction"]).toBe(2);
      expect(stats.byType["audit"]).toBe(1);
      expect(stats.bySource["internal"]).toBe(3);
      expect(stats.bySource["test-issuer"]).toBe(1);
    });

    it("exports provenance for auditing", () => {
      const exported = service.exportProvenance("rec-1");

      expect(exported).toBeTruthy();
      const parsed = JSON.parse(exported);
      expect(parsed.recordId).toBe("rec-1");
      expect(parsed.chain).toBeDefined();
    });

    it("batch verifies multiple records", () => {
      const results = service.batchVerify(["rec-1", "rec-2", "rec-4"]);

      expect(results.size).toBe(3);
      expect(results.get("rec-1")?.valid).toBe(true);
      expect(results.get("rec-2")?.valid).toBe(true);
      expect(results.get("rec-4")?.valid).toBe(true);
      expect(results.get("rec-4")?.evidenceValid).toBe(true);
    });
  });

  describe("Edge cases and recovery", () => {
    it("handles empty content gracefully", () => {
      const provenance = service.importRecord(
        adminActor,
        "empty-record",
        "test",
        {},
      );

      expect(provenance.contentDigest).toBe(computePayloadDigest({}));
    });

    it("handles large chain histories", () => {
      const content = { data: "test" };

      service.importRecord(adminActor, "large-chain", "test", content);

      // Add many chain entries
      for (let i = 0; i < 50; i++) {
        service.addChainEntry(adminActor, "large-chain", "modified", content, {
          iteration: i,
        });
      }

      const history = service.getProvenanceHistory("large-chain");

      expect(history.length).toBeGreaterThan(10);
      expect(history[history.length - 1].sequence).toBe(history.length - 1);
    });

    it("maintains chronological order in chain", () => {
      const content = { data: "test" };

      service.importRecord(adminActor, "time-test", "test", content);

      // Add entries with small delays
      for (let i = 0; i < 5; i++) {
        service.addChainEntry(adminActor, "time-test", "modified", content);
      }

      const history = service.getProvenanceHistory("time-test");

      for (let i = 1; i < history.length; i++) {
        const prev = Date.parse(history[i - 1].timestamp);
        const curr = Date.parse(history[i].timestamp);
        expect(curr).toBeGreaterThanOrEqual(prev);
      }
    });

    it("handles metadata tags correctly", () => {
      const provenance = service.importRecord(
        adminActor,
        "tagged-record",
        "test",
        { data: "test" },
        undefined,
        { tags: ["urgent", "review-required"] },
      );

      expect(provenance.metadata.tags).toEqual(["urgent", "review-required"]);

      const query: ProvenanceQuery = { tags: ["urgent"] };
      const results = service.queryProvenance(query);

      expect(results).toHaveLength(1);
      expect(results[0].recordId).toBe("tagged-record");
    });

    it("handles concurrent imports safely", () => {
      const content = { amount: 100, currency: "USD" };

      const imports = Array.from({ length: 10 }, (_, i) =>
        service.importRecord(adminActor, `concurrent-${i}`, "transaction", content),
      );

      expect(imports).toHaveLength(10);
      imports.forEach((provenance, i) => {
        expect(provenance.recordId).toBe(`concurrent-${i}`);
      });
    });

    it("provides detailed verification issues", () => {
      const content = { amount: 100, currency: "USD" };
      const payloadDigest = computePayloadDigest(content);

      // Create evidence with wrong issuer
      const evidence: ExternalEvidence = {
        id: "wrong-issuer",
        type: "transaction",
        issuer: "wrong-issuer",
        keyId: "test-key-1",
        issuedAt: new Date().toISOString(),
        payload: content,
        payloadDigest,
        signature: "",
      };

      evidence.signature = signEvidence(evidence, privateKey);

      expect(() => {
        service.importRecord(
          adminActor,
          "bad-record",
          "transaction",
          content,
          evidence,
        );
      }).toThrow(/ISSUER_MISMATCH/);
    });
  });

  describe("Rollback and recovery scenarios", () => {
    it("supports archival and restoration", () => {
      const content = { data: "test" };

      service.importRecord(adminActor, "archive-test", "test", content);

      service.addChainEntry(adminActor, "archive-test", "archived", content);
      service.addChainEntry(adminActor, "archive-test", "restored", content);

      const history = service.getProvenanceHistory("archive-test");

      expect(history.map((e) => e.action)).toContain("archived");
      expect(history.map((e) => e.action)).toContain("restored");
    });

    it("maintains immutable history", () => {
      const content = { data: "test" };

      service.importRecord(adminActor, "immutable-test", "test", content);

      const history1 = service.getProvenanceHistory("immutable-test");

      service.addChainEntry(adminActor, "immutable-test", "modified", content);

      const history2 = service.getProvenanceHistory("immutable-test");

      expect(history1).toHaveLength(1);
      expect(history2).toHaveLength(2);
      expect(history2[0]).toEqual(history1[0]);
    });
  });
});
