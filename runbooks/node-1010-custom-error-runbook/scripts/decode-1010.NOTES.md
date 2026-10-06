# Notes: `decode-1010.mjs`

What the script does, how each symptom in the
[1010 runbook](../node-1010-custom-error-runbook.md) was reproduced, and how the script was
tested. **The user runs it** on their own error text; it signs and submits nothing.

## What the script reads

| Input | Pattern | Output |
| --- | --- | --- |
| Ledger code | `Custom error: N` anywhere (RPC error, `String(err)`, `RPC-CORE` line, JSON) | name, category, a hint for codes with a reproduction or worked case, and what the code is on the other node line |
| Pool error | `10xx: <Substrate message>[: data]` or `"code":10xx,"message":…` | the Substrate meaning; for 1010 without a number, the reason text |
| Node log | `Rejected transaction <hash> from mempool: Transaction Error: …` or `… guaranteed execution would fail: …` | the code that variant maps to |
| Bare number | 0-255 (ledger) or 1001-1021 (pool) | as above |
| Wallet wrapper only | `Transaction submission error`, `SubmissionError`, `Unexpected error submitting scoped transaction` with no code | exit 2 and how to get the code out |

The table comes from `--node 1.0|2.x`, or from `system_version` when given `--rpc`; without
either it uses 1.0.x and says so. A `system_version` that is neither 1.0.x nor 2.x stops the
script (exit 1) rather than decode against the wrong table.

## How the tables were made

Not typed by hand. A parser read `impl From<LedgerApiError> for u8` from each file below into
code → variant path, and the result was embedded in the script. A second check loads the tables
back out of the script and compares them with the parsed source: 0 mismatches.

| Table | Source | Codes |
| --- | --- | --- |
| `NODE_1_0` | midnight-node tag `node-1.0.400` (`3acfd2edecdcd91373b6a506933f4c14ad3f0308`), `ledger/src/versions/common/types.rs` | 120 |
| `NODE_2_X` | tag `node-2.1.0-rc.4` (`1b2b31c714f8986a082b8690f15e805981c771dd`), `ledger/src/ledger_8/types.rs` | 155 |

Same table, checked: `node-1.0.0`, `node-1.0.2`, `node-1.0.300` and `release/node-1.0.400` equal
`node-1.0.400`; `ledger_9/types.rs` equals `ledger_8/types.rs` at `node-2.1.0-rc.4`, and both
equal `main` at `b2f85e1626edb8dec8e49841e69f95943ec7b4e0`. `node-2.0.0-rc.4` differs only in
lacking 140 (`SystemTransaction.NotAllowedForCaller`). The `SPLIT` map (which 2.x codes replace a
1.0.x code) was checked the same way: every new code's name starts with the old code's name.

The docs pages were compared with these tables by the same parser: `docs/nodes/error-codes.mdx`
(midnight-docs `main`, last changed 2026-09-23) matches node 1.0.400 except that 211 is missing;
`docs/troubleshoot/decode-1010-transaction-rejection-errors.mdx` matches node 2.x except that 140
is missing, and marks 168, 182, 186, 187, 188, 193 and 205 as retired.

## Verified before hand-off (2026-10-06)

### Reproductions

Local network from `midnight-local-dev` (`902561d`) with `midnightntwrk/midnight-node:1.0.400`
(`system_version` `1.0.400-87c0fbdb`), `indexer-standalone` 4.3.3 and `proof-server` 8.1.0;
client `ledger-v8` 8.1.0, `wallet-sdk-facade` 4.1.0, `effect` 3.22.0, Node 24.20.0. The genesis
wallet sent itself 1 NIGHT per case. Run twice, same results both times.

| Case | Result | Node log |
| --- | --- | --- |
| Intent TTL now - 5 min | `1010: Invalid Transaction: Custom error: 182` | `Intent TTL has expired. TTL: …, Current block: …`, then `Transaction Error: Malformed(TransactionApplicationError)` |
| Intent TTL now + 30 days | `Custom error: 182` | `Intent TTL is too far in the future. TTL: Timestamp(1793912570), Maximum allowed: Timestamp(1792530186)`, about block time + 14 days |
| Intent TTL now + 30 min | accepted | none |
| Same finalized transaction again, at once | accepted, same id, in 11 and 19 ms | none |
| Same transaction again after it was included (30 s) | `Custom error: 193` | `guaranteed execution would fail: ReplayProtectionViolation(IntentAlreadyExists)` |
| Second wallet instance on the same seed spends the same DUST, before and after the first landed | `Custom error: 196` both times | `dust double spend …`, then `guaranteed execution would fail: DustDoubleSpend(DustNullifier(…))` |
| Same expired transaction three times (at once, at once, after 5 s) | 182; then no code, stderr `disconnected from ws://127.0.0.1:9944/: 1000:: Normal Closure`; then 182 again | 1012 never appeared |

What each way of printing the rejected error showed (expired-TTL case):

| Expression | Has `Custom error: 182` |
| --- | --- |
| `err.name` / `err.message` | no: `(FiberFailure) SubmissionError` / `Transaction submission error` |
| `err.stack` | no |
| `JSON.stringify(err)` | no |
| `err.cause` | `undefined` |
| `String(err)` | yes |
| `util.inspect(err)` (what `console.error` prints in Node.js) | yes |
| stderr | yes, `RPC-CORE: submitAndWatchExtrinsic(…): ExtrinsicStatus:: 1010: Invalid Transaction: Custom error: 182`, twice per rejection |

### Not reproduced

- **Old proof server (8.0.3) to provoke 170:** the wallet never reached proving (no request at
  either proof server in 15 minutes) and the run was stopped. 170 is documented from
  `servicedesk#52` and `servicedesk#150` only.
- 168, 186, 231, 232 and `Transaction would exhaust the block limits`: taken from the worked
  cases and the ledger source.
- Browser consoles, the DApp Connector path and Midnight.js scoped transactions (the last from
  midnight-js 4.1.1 source: the message is built with `String(err)`).
- A client clock that is off: from `wallet-sdk-facade` 4.1.0 source (`defaultTtl()` adds
  `DEFAULT_TTL_MS`, 1 hour, to the wallet clock's now).

### Script test runs

| Input | Exit | Output |
| --- | --- | --- |
| reproduction log with 182, 193 and 196 `RPC-CORE` lines | 0 | all three decoded once each |
| stderr of the `String(err)` run | 0 | 182 |
| captured node log (9 lines) | 0 | `Malformed(TransactionApplicationError)` → 182, `Invalid(ReplayProtectionViolation(IntentAlreadyExists))` → 193, `Invalid(DustDoubleSpend(DustNullifier))` → 196; with `--node 2.x`: 244, 196, and no match for the 1.0.x-only variant |
| `1010: Invalid Transaction: Custom error: 168: (FiberFailure) SubmissionError: …` (`servicedesk#100`) | 0 | 168, split into 231 and 232 on 2.x |
| JSON-RPC envelope with `Custom error: 170` | 0 | 170 |
| `RpcError: 1010: Invalid Transaction: Transaction would exhaust the block limits` | 0 | points at the batched deploy runbook |
| `231` | 0 | not a 1.0.x code; 2.x `OutsideTimeToDismiss`; on 1.0.x the same failure is 168 |
| `231 --node 2.x`, `182 --node 2.x` | 0 | decoded; 182 points at 228 to 230 |
| `103` | 0 | 1.0.x name; 2.x `Invalid.Zswap.Unknown` and its splits |
| `1010`, `1016` | 0 | envelope explanation; pool full |
| `300`, `5000` | 1 | neither a ledger nor a pool code |
| `SubmissionError: Transaction submission error` | 2 | no code; how to print `String(err)` |
| empty stdin | 2 | no node rejection found |
| `--rpc https://rpc.preprod.midnight.network`, `--rpc http://127.0.0.1:9944` | 0 | `1.0.400-c338b9ac`, `1.0.400-87c0fbdb`; 1.0.x table |
| `--rpc` with `--node`, `--node 3`, `--rpc notaurl`, `--rpc http://127.0.0.1:1`, `--bogus` | 1 | one-line error |
| Blockfrost preprod RPC with a fake `BLOCKFROST_PROJECT_ID` | 1 | `HTTP 403 (Blockfrost rejected BLOCKFROST_PROJECT_ID; tokens are per network)`; key not printed |

## Re-verify when versions move

- When a network upgrades its node, check `system_version`. If it reports 2.x, the decoder
  already has the table, but check it against that release's `types.rs` (2.x was taken from a
  release candidate), and swap the runbook's 1.0.x examples for their 2.x codes.
- On a new node line (neither 1.0.x nor 2.x), regenerate the table from that tag's
  `impl From<LedgerApiError> for u8` and re-run the parser check above.
- Re-run the reproductions on a local network with the new node image: the 182, 193 and 196
  cases each take under a minute once the wallet has synced.
