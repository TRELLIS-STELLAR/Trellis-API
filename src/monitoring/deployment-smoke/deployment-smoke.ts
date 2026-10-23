export type DeploymentAddressKind = "account" | "contract";

export interface InitializedAddress {
  name: string;
  address: string;
  kind: DeploymentAddressKind;
  required?: boolean;
}

export interface SmokeProbeResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface DeploymentSmokeResult extends InitializedAddress {
  ok: boolean;
  attempts: number;
  status?: number;
  error?: string;
}

export interface DeploymentSmokeReport {
  allPassed: boolean;
  passed: number;
  failed: number;
  results: DeploymentSmokeResult[];
}

export type DeploymentProbe = (
  address: InitializedAddress,
  authorizationProbe: boolean,
) => Promise<SmokeProbeResult>;

export interface DeploymentSmokeOptions {
  maxAttempts?: number;
  backoffMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  probeAuthorization?: boolean;
}

const DEFAULT_SLEEP = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function validateAddresses(addresses: InitializedAddress[]): void {
  const names = new Set<string>();
  const values = new Set<string>();
  for (const entry of addresses) {
    if (!entry.name.trim() || !entry.address.trim()) {
      throw new Error("Every initialized address needs a name and address");
    }
    if (names.has(entry.name) || values.has(entry.address)) {
      throw new Error(`Duplicate initialized address entry: ${entry.name}`);
    }
    names.add(entry.name);
    values.add(entry.address);
  }
}

export async function runDeploymentSmokeTests(
  addresses: InitializedAddress[],
  probe: DeploymentProbe,
  options: DeploymentSmokeOptions = {},
): Promise<DeploymentSmokeReport> {
  validateAddresses(addresses);
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const sleep = options.sleep ?? DEFAULT_SLEEP;
  const results: DeploymentSmokeResult[] = [];

  for (const address of addresses) {
    let last: SmokeProbeResult = { ok: false, error: "No probe result" };
    let attempts = 0;
    while (attempts < maxAttempts) {
      attempts += 1;
      last = await probe(address, false);
      if (last.ok) break;
      if (attempts < maxAttempts) {
        await sleep(options.backoffMs ?? 100 * 2 ** (attempts - 1));
      }
    }

    if (options.probeAuthorization) {
      const authorization = await probe(address, true);
      if (authorization.ok || authorization.status !== 401 && authorization.status !== 403) {
        last = { ok: false, status: authorization.status, error: "Authorization probe did not fail closed" };
      }
    }

    results.push({ ...address, ok: last.ok, attempts, status: last.status, error: last.error });
  }

  const failed = results.filter((result) => !result.ok && result.required !== false).length;
  return { allPassed: failed === 0, passed: results.filter((result) => result.ok).length, failed, results };
}
