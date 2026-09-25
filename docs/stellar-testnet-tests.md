# Stellar testnet integration tests

Run `npm run test:testnet` with Node 22. The suite uses the real Horizon testnet
and Friendbot endpoints. Set `STELLAR_HORIZON_URL` and `STELLAR_FRIENDBOT_URL` to
override the defaults. It creates disposable keypairs, funds them with Friendbot,
submits a one XLM payment through `StellarAdapter`, checks confirmation by hash,
and verifies that an oversized payment is rejected by the ledger. No secrets are
stored in CI. The workflow runs weekly and can be started manually; it does not
gate pull requests. Friendbot funding and ledger submission consume testnet
resources and may take several minutes.

`TESTNET_UNAVAILABLE` in setup means Horizon or Friendbot could not be reached or
funding failed. Other failures indicate an adapter, SDK, or ledger behavior mismatch
and should be investigated as code failures. Rerun unavailable tests after the
network recovers.

The oracle submitter currently calls an EVM contract via ethers rather than a
Soroban contract. No deployed testnet Soroban oracle ID or callable interface is
configured in this repository, so this suite cannot submit an oracle payload to
Stellar. Oracle ledger coverage requires a deployed contract and API integration
with its interface; the existing `test/oracle-e2e.spec.ts` exercises only the API.
