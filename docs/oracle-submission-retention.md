# Oracle submission history

`POST /oracle/submissions` registers a submitted Stellar transaction for verification.
It requires `oracle:submit`; `GET /oracle/submissions` requires `oracle:verify` and
supports `limit` (1–100) and `offset`. Registration means pending, not trusted.

The database keeps payload hash, submitter, transaction hash, verification status,
failure reason and timestamps. Unique indexes reject duplicate payload hashes and
transaction hashes atomically, including concurrent submissions. Hashes are
normalized to lowercase before lookup. Pending verification reads at most 100 rows.

Retention policy: retain this compact register indefinitely, including rejected
records. No automatic deletion or TTL is applied. Back up it with the application
database. Any future archival implementation must leave both unique replay keys
online and preserve the verification audit data in a recoverable archive; deleting
keys would allow historical replays. This conservative policy needs no retention
worker and applies across process restarts.
