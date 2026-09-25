import { ConfigService } from "@nestjs/config";
import { Horizon, Keypair, Networks } from "@stellar/stellar-sdk";
import { StellarAdapter } from "../../src/payments/adapters/stellar/stellar.adapter";
import { PaymentStatus } from "../../src/payments/interfaces/payment-processor.interface";

const horizonUrl =
  process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const friendbotUrl =
  process.env.STELLAR_FRIENDBOT_URL ?? "https://friendbot.stellar.org";
const server = new Horizon.Server(horizonUrl);

async function fund(address: string): Promise<void> {
  const response = await fetch(
    `${friendbotUrl}/?addr=${encodeURIComponent(address)}`,
  );
  if (!response.ok)
    throw new Error(
      `Friendbot funding failed: HTTP ${response.status} ${await response.text()}`,
    );
}

describe("live Stellar testnet payment", () => {
  const source = Keypair.random();
  const destination = Keypair.random();
  const config = {
    get: (key: string, fallback?: string) =>
      ({
        STELLAR_NETWORK_PASSPHRASE: Networks.TESTNET,
        STELLAR_SIGNING_SECRET: source.secret(),
      })[key] ?? fallback,
  } as ConfigService;
  const adapter = new StellarAdapter(server, config);

  beforeAll(async () => {
    try {
      await server.root();
    } catch (error) {
      throw new Error(
        `TESTNET_UNAVAILABLE: Horizon preflight failed: ${String(error)}`,
      );
    }
    try {
      await fund(source.publicKey());
      await fund(destination.publicKey());
      await server.loadAccount(source.publicKey());
      await server.loadAccount(destination.publicKey());
    } catch (error) {
      throw new Error(
        `TESTNET_UNAVAILABLE: Friendbot or account setup failed: ${String(error)}`,
      );
    }
  });

  it("submits a payment and confirms its hash on Horizon", async () => {
    const created = await adapter.createPayment({
      amount: "1",
      currency: "XLM",
      destination: destination.publicKey(),
      idempotencyKey: "testnet-payment",
      reference: "trellis-testnet",
    });
    const signed = await adapter.signTransaction(created);
    const submitted = await adapter.submitTransaction(signed);
    expect(submitted.status).toBe(PaymentStatus.CONFIRMED);
    expect(submitted.transactionHash).toMatch(/^[a-f0-9]{64}$/i);
    const status = await adapter.getStatus(submitted.transactionHash);
    expect(status.status).toBe(PaymentStatus.CONFIRMED);
    expect(status.transactionHash).toBe(submitted.transactionHash);
  });

  it("rejects an on-ledger payment that exceeds the account balance", async () => {
    const created = await adapter.createPayment({
      amount: "100000000",
      currency: "XLM",
      destination: destination.publicKey(),
      idempotencyKey: "testnet-insufficient-balance",
    });
    const signed = await adapter.signTransaction(created);
    await expect(adapter.submitTransaction(signed)).rejects.toThrow(
      /underfunded|insufficient|failed to submit/i,
    );
  });
});
