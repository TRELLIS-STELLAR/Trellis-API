# Stellar oracle verification

Configure `SOROBAN_RPC_URL` (HTTPS), `ORACLE_CONTRACT_ADDRESS` (Stellar C address)
and `STELLAR_NETWORK_PASSPHRASE` (defaults to Stellar testnet). For mainnet use
the mainnet RPC endpoint and `Public Global Stellar Network ; September 2015`.
`ORACLE_MIN_CONFIRMATIONS` defaults to 1 closed ledger, `ORACLE_RPC_MAX_RETRIES`
to 3 and `ORACLE_RPC_RETRY_DELAY_MS` to 250. Transient transport failures use
bounded exponential backoff; failed transactions and invalid invocations do not.

The upstream repository formerly called Trellis is now
[Trellis-contracts](https://github.com/TRELLIS-STELLAR/Trellis-contracts).
The verifier matches its
[oracle contract](https://github.com/TRELLIS-STELLAR/Trellis-contracts/blob/main/contracts/oracle-contract/src/lib.rs)
`submit_price(submitter: Address, feed_id: Symbol, price: i128, decimals: u32,
timestamp: u64, nonce: u64)` interface. It accepts a single direct invocation.
The successful transaction is evidence that the contract's submitter authorization,
nonce and price validation ran. The returned envelope hash, network, contract,
method, argument types, submitter and payload digest must all match.

After submitting a Stellar transaction, register its reference using
`POST /oracle/submissions`. The payload hash is lowercase SHA-256 of the canonical
XDR `ScVal` vector containing all six `submit_price` arguments in ABI order.
`hashOracleArguments` implements this shared representation; use Stellar SDK
typed values (Address, Symbol, i128, u32, u64, u64) when constructing it.
This binds the price, precision, observation time and nonce to the submitter.
The verifier polls pending references in batches of 100 and persists verified or
rejected outcomes. Missing transactions and insufficient confirmations stay pending.

Soroban RPC retains a limited transaction window. Old references require a compatible
archival RPC; missing history must never be considered proof of verification.

The separate legacy payload signing and submission services use a different protocol.
Their payloads are not automatically treated as Stellar submissions. This verifier
requires a successful Stellar `submit_price` transaction and its matching XDR digest;
it does not invent a contract ABI for legacy payloads. Changes to the upstream ABI
must update this document and the invocation fixtures together.
