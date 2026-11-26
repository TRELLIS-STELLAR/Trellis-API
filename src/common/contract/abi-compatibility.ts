export interface AbiParameter {
  name: string;
  type: string;
  optional?: boolean;
}

export interface AbiFunction {
  name: string;
  inputs: AbiParameter[];
  outputs: AbiParameter[];
}

export interface ContractAbi {
  functions: AbiFunction[];
}

export type AbiCompatibilitySeverity = "breaking" | "warning";

export interface AbiCompatibilityFinding {
  code:
    | "MISSING_FUNCTION"
    | "INPUT_CHANGED"
    | "OUTPUT_CHANGED"
    | "INPUT_ADDED"
    | "DUPLICATE_FUNCTION";
  severity: AbiCompatibilitySeverity;
  functionName: string;
  message: string;
}

export interface AbiCompatibilityReport {
  compatible: boolean;
  findings: AbiCompatibilityFinding[];
}

/**
 * Compares the public contract ABI with the DTO-facing ABI captured by the API.
 * Inputs are compared positionally because Soroban clients encode arguments in
 * declaration order. Optional trailing inputs may be added without breaking
 * existing callers; all other changes require a coordinated DTO migration.
 */
export function validateAbiCompatibility(
  contract: ContractAbi,
  api: ContractAbi,
): AbiCompatibilityReport {
  const findings: AbiCompatibilityFinding[] = [];
  const apiFunctions = new Map<string, AbiFunction>();
  const duplicateNames = new Set<string>();

  for (const fn of api.functions) {
    if (apiFunctions.has(fn.name)) duplicateNames.add(fn.name);
    apiFunctions.set(fn.name, fn);
  }

  for (const name of duplicateNames) {
    findings.push({
      code: "DUPLICATE_FUNCTION",
      severity: "breaking",
      functionName: name,
      message: `API ABI declares '${name}' more than once`,
    });
  }

  for (const contractFunction of contract.functions) {
    const apiFunction = apiFunctions.get(contractFunction.name);
    if (!apiFunction) {
      findings.push({
        code: "MISSING_FUNCTION",
        severity: "breaking",
        functionName: contractFunction.name,
        message: `API ABI is missing contract function '${contractFunction.name}'`,
      });
      continue;
    }

    compareParameters(contractFunction, apiFunction, "inputs", findings);
    compareParameters(contractFunction, apiFunction, "outputs", findings);
  }

  for (const apiFunction of api.functions) {
    if (!contract.functions.some((fn) => fn.name === apiFunction.name)) {
      findings.push({
        code: "INPUT_ADDED",
        severity: "warning",
        functionName: apiFunction.name,
        message: `API ABI exposes '${apiFunction.name}', which is not present in the contract ABI`,
      });
    }
  }

  return {
    compatible: findings.every((finding) => finding.severity !== "breaking"),
    findings,
  };
}

function compareParameters(
  contractFunction: AbiFunction,
  apiFunction: AbiFunction,
  kind: "inputs" | "outputs",
  findings: AbiCompatibilityFinding[],
): void {
  const contractParameters = contractFunction[kind];
  const apiParameters = apiFunction[kind];
  const sharedLength = Math.min(contractParameters.length, apiParameters.length);

  for (let index = 0; index < sharedLength; index += 1) {
    const expected = contractParameters[index];
    const actual = apiParameters[index];
    if (expected.type !== actual.type || expected.name !== actual.name) {
      findings.push({
        code: kind === "inputs" ? "INPUT_CHANGED" : "OUTPUT_CHANGED",
        severity: "breaking",
        functionName: contractFunction.name,
        message: `${kind} ${index + 1} of '${contractFunction.name}' changed from ${expected.name}:${expected.type} to ${actual.name}:${actual.type}`,
      });
    }
  }

  if (apiParameters.length < contractParameters.length) {
    findings.push({
      code: kind === "inputs" ? "INPUT_CHANGED" : "OUTPUT_CHANGED",
      severity: "breaking",
      functionName: contractFunction.name,
      message: `${kind} of '${contractFunction.name}' are missing ${contractParameters.length - apiParameters.length} contract field(s)`,
    });
  }

  if (kind === "inputs" && apiParameters.length > contractParameters.length) {
    const added = apiParameters.slice(contractParameters.length);
    if (!added.every((parameter) => parameter.optional === true)) {
      findings.push({
        code: "INPUT_ADDED",
        severity: "breaking",
        functionName: contractFunction.name,
        message: `API ABI adds required input(s) to '${contractFunction.name}'`,
      });
    }
  }
}
