# Production configuration contract

The API checks critical configuration during startup. Production startup stops
when `DATABASE_URL` or `JWT_SECRET` is missing, a known test network is
configured for production, Stellar is selected for payments without its Horizon
URL, network passphrase, and signing secret, or Soroban is configured with only
one of `SOROBAN_RPC_URL` and `ORACLE_CONTRACT_ADDRESS`. A configured Soroban URL
must use HTTPS and the contract address must be a valid Stellar contract ID.
Validation errors name the setting but do not print its value.

## Deployment and failure recovery

1. Set secrets in the deployment secret manager and network endpoints in the
   environment-specific configuration. Keep testnet values in development and
   staging only.
2. Deploy the configuration and application together. If startup reports a
   missing or invalid setting, correct the secret/configuration revision and
   restart; readiness should remain false until startup succeeds.
3. If a production configuration change causes an outage, restore the last
   known-good configuration revision and, if needed, roll back the application
   release using the deployment runbook. Rotate any secret that was exposed or
   entered into an unintended environment.
4. Before retrying, check that the Soroban RPC endpoint and contract belong to
   the same network. The adapter also checks the RPC network passphrase at
   runtime and rejects mismatches before verifying a transaction.

These checks do not change API routes or schemas. Optional integrations remain
disabled when their configuration is absent; the Soroban endpoint and contract
must be supplied as a pair when enabling oracle verification.
