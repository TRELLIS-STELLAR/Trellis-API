import { validateAbiCompatibility, ContractAbi } from "./abi-compatibility";

const contract: ContractAbi = {
  functions: [
    {
      name: "settle",
      inputs: [{ name: "amount", type: "i128" }],
      outputs: [{ name: "receipt", type: "bytes" }],
    },
  ],
};

describe("validateAbiCompatibility", () => {
  it("accepts an identical contract and DTO ABI", () => {
    expect(validateAbiCompatibility(contract, structuredClone(contract))).toEqual({
      compatible: true,
      findings: [],
    });
  });

  it("reports missing functions and changed fields", () => {
    const report = validateAbiCompatibility(contract, {
      functions: [
        {
          name: "settle",
          inputs: [{ name: "value", type: "u64" }],
          outputs: [],
        },
      ],
    });

    expect(report.compatible).toBe(false);
    expect(report.findings.map((finding) => finding.code)).toEqual([
      "INPUT_CHANGED",
      "OUTPUT_CHANGED",
    ]);
  });

  it("allows optional trailing inputs and warns about API-only functions", () => {
    const report = validateAbiCompatibility(contract, {
      functions: [
        {
          name: "settle",
          inputs: [
            { name: "amount", type: "i128" },
            { name: "memo", type: "string", optional: true },
          ],
          outputs: [{ name: "receipt", type: "bytes" }],
        },
        { name: "preview", inputs: [], outputs: [] },
      ],
    });

    expect(report.compatible).toBe(true);
    expect(report.findings).toEqual([
      expect.objectContaining({ code: "INPUT_ADDED", severity: "warning" }),
    ]);
  });
});
