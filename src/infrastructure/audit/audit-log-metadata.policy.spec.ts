import { minimizeAuditDetails, minimizeAuditMetadata } from "./audit-log-metadata.policy";

describe("audit log metadata minimization", () => {
  it("keeps investigation and retention fields, drops unrelated metadata, and redacts secrets", () => {
    expect(
      minimizeAuditMetadata({
        adminId: "admin-1",
        activeDisputeId: "case-1",
        debugPayload: { password: "do-not-store" },
        requestBody: "large payload",
      }),
    ).toEqual({ adminId: "admin-1", activeDisputeId: "case-1" });
  });

  it("redacts email and Stellar secret text and bounds free-form details", () => {
    expect(minimizeAuditDetails("Impersonation started for person@example.com"))
      .toBe("Impersonation started for [email]");
    expect(minimizeAuditDetails(`credential S${"A".repeat(55)}`)).toBe("credential [secret]");
    expect(minimizeAuditDetails("x".repeat(600))).toHaveLength(500);
  });
});
