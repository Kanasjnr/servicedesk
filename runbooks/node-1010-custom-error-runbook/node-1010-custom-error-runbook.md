# Runbook: Node rejects a transaction ("1010: Invalid Transaction: Custom error: N")

A transaction is built, proved and balanced, and the node turns it away at submission. The DApp
gets `Transaction submission error` and nothing else: the node's reason is a number,
`Custom error: N`, two causes down the error chain, and `err.message` doesn't carry it. Use this
runbook to get the number out, decode it against the code table of the node version that
rejected the transaction, and match it to a cause and a fix. The numbers aren't stable across
node versions: node 2.x drops or renames ten of the codes node 1.0.x uses, and the docs'
"Decode 1010 errors" page lists the 2.x table although every public network runs node 1.0.400.

_Compiled 2026-10-06 from local reproductions on node 1.0.400 (method and results in
[`scripts/decode-1010.NOTES.md`](scripts/decode-1010.NOTES.md)). Sources, pinned:_

- _midnight-node `node-1.0.400` (`3acfd2edecdcd91373b6a506933f4c14ad3f0308`):
  `ledger/src/versions/common/types.rs` (the code table), `pallets/midnight/src/lib.rs`_
- _midnight-node `node-2.1.0-rc.4` (`1b2b31c714f8986a082b8690f15e805981c771dd`):
  `ledger/src/ledger_8/types.rs`_
- _midnight-ledger `ledger-8.1.2` (`36d7442172136758e33009f75ff4aa56616cff40`):
  `ledger/src/error.rs` (the texts in the node log)_
- _polkadot-sdk `polkadot-stable2603` (`2e4dd0bc22366a5af820492528869a493b5a5208`):
  `substrate/client/rpc-api/src/author/error.rs`_
- _`@midnight-ntwrk/wallet-sdk-facade` 4.1.0, `wallet-sdk-node-client` 1.1.3, `effect` 3.22.0,
  midnight-js 4.1.1_
- _live node RPC on preview, preprod and mainnet (`system_version` `1.0.400-c338b9ac`)_

_Node versions and their code tables move: re-check them before asserting anything._

---

## Symptom

Everything below was reproduced on a local network running node 1.0.400 unless marked otherwise.

- **The wallet SDK rejects with a message that has no reason** (→ Diagnose 1):

  ```text
  (FiberFailure) SubmissionError: Transaction submission error
  ```

  That is `err.name` and `err.message`. `err.stack` and `JSON.stringify(err)` don't contain the
  node's code either, and `err.cause` is `undefined`. `String(err)`, and `console.error(err)` in
  Node.js, print the whole chain:

  ```text
  (FiberFailure) SubmissionError: Transaction submission error
      at …
    [cause]: SubmissionError: Transaction submission failed
        at …
      [cause]: RpcError: 1010: Invalid Transaction: Custom error: 182
  ```

- **The console has the code even when the DApp swallows the error.** The RPC client logs this to
  stderr on every rejection:

  ```text
  RPC-CORE: submitAndWatchExtrinsic(extrinsic: Extrinsic): ExtrinsicStatus:: 1010: Invalid Transaction: Custom error: 196
  ```

- **Midnight.js scoped transactions** put the same chain into their message:
  `Unexpected error submitting scoped transaction '<name>': (FiberFailure) SubmissionError: …`
  (midnight-js 4.1.1 builds it with `String(err)`; from source, not reproduced).
- **A client that shows the raw JSON-RPC response** (`servicedesk#54`):

  ```json
  {"jsonrpc":"2.0","id":4,"error":{"code":1010,"message":"Invalid Transaction","data":"Custom error: 168"}}
  ```

- **The node log, if you run the node.** Two forms: well-formedness failures and ledger-state
  failures. The line before a `Malformed` one has the ledger's own text:

  ```text
  Transaction malformed: transaction application error detected during verification: Intent TTL has expired. TTL: Timestamp(1791320261), Current block: Timestamp(1791320580)
  🚫 Rejected transaction 7a041e26… from mempool: Transaction Error: Malformed(TransactionApplicationError)
  🚫 Rejected transaction e5505985… from mempool: guaranteed execution would fail: ReplayProtectionViolation(IntentAlreadyExists)
  ```

- **1010 with text instead of a number** (→ the
  [batched deploy runbook](../contract-batched-deploy-runbook/contract-batched-deploy-runbook.md)):
  `1010: Invalid Transaction: Transaction would exhaust the block limits`. That's a Substrate
  check, not the Midnight ledger (`servicedesk#225`; not reproduced here).
- **No 1010 anywhere in `String(err)`:** the node didn't reject anything. Seen once when the same
  transaction was submitted again straight after a rejection: the stderr line read
  `disconnected from ws://127.0.0.1:9944/: 1000:: Normal Closure` and the error had no code. Five
  seconds later the same submission reached the node again.

## Root cause

**How the number gets into the error** (from source):

1. The node validates every submitted transaction against the ledger (`validate_unsigned` in
   `pallet_midnight`). A failure is a `LedgerApiError`, which the node turns into a `u8` with
   `impl From<LedgerApiError> for u8` and returns as `InvalidTransaction::Custom(code)`
   (`pallets/midnight/src/lib.rs` L557-558).
2. Substrate's author RPC answers with code 1010, message `Invalid Transaction` and data
   `Custom error: N` (`author/error.rs` L107-111). The 1010 is Substrate's envelope; the N is
   Midnight's.
3. The wallet SDK wraps it three times: the RPC client's `RpcError`
   (`1010: Invalid Transaction: Custom error: N`), then `SubmissionError: Transaction submission
   failed` (`wallet-sdk-node-client`), then `SubmissionError: Transaction submission error`
   (`wallet-sdk-capabilities`). The promise API rejects with an Effect `FiberFailure`, whose
   `message` is the outermost text and which sets no `cause`; only its `toString()` renders the
   chain (`effect` 3.22.0, `internal/runtime.ts` L223-227). Anything that logs `err.message`
   loses the reason (`servicedesk#225`).

**Why the same number can mean different things.** The table is in the node and changes with
the node version. Nodes 1.0.0 to 1.0.400 share one table of 120 codes. Node 2.x (2.0.0-rc.4 to
2.1.0-rc.4, and `main`) has 155, and seven 1.0.x codes are gone, split into finer ones:

| 1.0.x | Name on 1.0.x | On node 2.x |
| --- | --- | --- |
| 168 | `Malformed.FeeCalculation` | 231 `OutsideTimeToDismiss`, 232 `BlockLimitExceeded` |
| 182 | `Malformed.TransactionApplicationError` | 228 `IntentTtlExpired`, 229 `IntentTtlTooFarInFuture`, 230 `IntentAlreadyExists` |
| 186 | `Malformed.EffectsCheckFailure` | 212 to 218 |
| 187 | `Malformed.DisjointCheckFailure` | 225 to 227 |
| 188 | `Malformed.SequencingCheckFailure` | 219 to 224 |
| 193 | `Invalid.ReplayProtectionViolation` | 242 to 244 (TTL expired, TTL too far ahead, intent already exists) |
| 205 | `SystemTransaction.ReplayProtectionFailure` | 245 to 247 |

103, 127 and 174 stay but become the `…Unknown` case of new splits (239 to 241 and 250, 235 to
238, 233 and 234), and 140, 156, 157, 248 and 249 are new. So `Custom error: 231`
(`servicedesk#117`) came from a node 2.0.0-rc.4 devnet; on node 1.0.x the same failure is 168.

**Two docs pages disagree.** [Node error codes](https://docs.midnight.network/nodes/error-codes)
matches node 1.0.400 (only 211, `SystemTransaction.MerkleTreeError`, is missing).
[Decode 1010 errors](https://docs.midnight.network/how-to/decode-1010-transaction-rejection-errors)
is the 2.x table: it marks 168, 182, 186, 187, 188, 193 and 205 as retired and lists 212 to 250
as current. Every public network runs 1.0.400 and returns 182 and 193 (both reproduced). Use the
Node error codes page until the networks move to 2.x.

**Malformed or Invalid.** A `Malformed` code means the transaction itself is wrong (structure,
proofs, signatures, balance, TTL, fees): rebuild it. An `Invalid` code means the transaction is
fine but the ledger state says no (already spent, already on chain): find out what got there
first. The node logs `Invalid` failures as "guaranteed execution would fail".

## Key identifiers

- **RPC error:** `{"code":1010,"message":"Invalid Transaction","data":"Custom error: N"}`, with N
  from 0 to 255. Without `Custom error:`, the data is Substrate's own reason (for example
  `Transaction would exhaust the block limits`). Other pool codes (`author/error.rs`): 1011
  Unknown Transaction Validity, 1012 Transaction is temporarily banned, 1013 Transaction Already
  Imported, 1014 Priority is too low, 1016 Immediately Dropped (the pool is full).
- **Code ranges on node 1.0.x:** 0-11 deserialization, 50-63 serialization, 100-109 and 193-200
  `Invalid`, 110-139 and 166-192 `Malformed`, 150-155 and 165 node ledger API, 201-211 system
  transactions, 255 host API.
- **Node version:** JSON-RPC `system_version`. `1.0.400-c338b9ac` on preview, preprod and
  mainnet on 2026-10-06; the `midnightntwrk/midnight-node:1.0.400` image reports
  `1.0.400-87c0fbdb`. The official endpoints need no key but are scheduled to shut down (see the
  [Blockfrost migration runbook](../indexer-blockfrost-migration-runbook/indexer-blockfrost-migration-runbook.md));
  Blockfrost's RPC needs a project token.
- **Code tables in source:**
  [node-1.0.400 `types.rs` L277-419](https://github.com/midnightntwrk/midnight-node/blob/3acfd2edecdcd91373b6a506933f4c14ad3f0308/ledger/src/versions/common/types.rs#L277-L419),
  [node-2.1.0-rc.4 `ledger_8/types.rs` L359-556](https://github.com/midnightntwrk/midnight-node/blob/1b2b31c714f8986a082b8690f15e805981c771dd/ledger/src/ledger_8/types.rs#L359-L556).
- **Wallet SDK error:** name `(FiberFailure) SubmissionError`; messages
  `Transaction submission error` (outer) and `Transaction submission failed` (inner).
- **Node log:** `Rejected transaction <hash> from mempool: Transaction Error: …` (`Malformed`)
  and `… from mempool: guaranteed execution would fail: …` (`Invalid`).
- **Wallet default TTL:** now + 1 hour by the machine's clock (`wallet-sdk-facade` 4.1.0,
  `DEFAULT_TTL_MS`), used when `transferTransaction` and friends get no `ttl`.

## Diagnose (no API key)

1. **Get the code.** Where you catch the submission error, log `String(err)` (or
   `console.error(err)` in Node.js), not `err.message`. If you can't change the code, search the
   console output for `RPC-CORE: submitAndWatchExtrinsic`. If you run the node, grep its log for
   `Rejected transaction`.
2. **Decode it.** The script needs Node >= 20, no install, and only reads the text you give it;
   with `--rpc` it also asks the node for its version.

   ```sh
   mkdir -p /tmp/decode-1010
   curl -fsSL -o /tmp/decode-1010/decode-1010.mjs \
     https://raw.githubusercontent.com/midnightntwrk/servicedesk/main/runbooks/node-1010-custom-error-runbook/scripts/decode-1010.mjs
   node /tmp/decode-1010/decode-1010.mjs app.log --rpc https://rpc.preprod.midnight.network
   npm start 2>&1 | node /tmp/decode-1010/decode-1010.mjs       # or pipe the output in
   node /tmp/decode-1010/decode-1010.mjs 182                     # or give it the number
   ```

   It finds every `Custom error: N`, every pool error and every `Rejected transaction` node log
   line. Pass `--rpc` with the URL the DApp submitted to, so it decodes against that node's
   version, or `--node 1.0` / `--node 2.x`; without either it assumes 1.0.x and says so. For
   Blockfrost, `export BLOCKFROST_PROJECT_ID=…` first; the key is never printed. Exit code: 0 =
   decoded at least one rejection, 2 = no node rejection in the input (it says how to get one
   out of the SDK error), 1 = it could not run. Example:

   ```text
   Code table: node 1.0.x (1.0.0 to 1.0.400). https://rpc.preprod.midnight.network runs
   1.0.400-c338b9ac.

   Custom error: 196 → Invalid.DustDoubleSpend
     Invalid: the transaction is well-formed but conflicts with the ledger state it was checked
     against.
     The DUST that pays the fee is already spent. Reproduced on node 1.0.400 with two wallet instances
     on one seed, before and after the first transaction landed. Fix: one wallet instance per seed, and
     let the wallet sync its last transaction before building the next one.
   ```

   A code from the other node line gets a pointer instead (`231` on 1.0.x: "not a code on node
   1.0.x. On node 2.x it is Malformed.FeeCalculation.OutsideTimeToDismiss. On node 1.0.x the same
   failure is 168").
3. **By hand, if you can't run it:** check the node version, then look the code up on the
   [Node error codes](https://docs.midnight.network/nodes/error-codes) page for 1.0.x, or in the
   2.x source above.

   ```sh
   curl -s -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"system_version","params":[]}' \
     https://rpc.preprod.midnight.network
   ```

4. **Match it to a cause.** The codes that come up in practice, on node 1.0.x:

   | Code | Name | What happened | Seen in | Fix |
   | --- | --- | --- | --- | --- |
   | 182 | `Malformed.TransactionApplicationError` | Intent TTL expired or too far ahead (or the intent already exists); the node log says which | reproduced; `servicedesk#235` (node log) | Remediation 1 |
   | 193 | `Invalid.ReplayProtectionViolation` | The intent is already on chain: the transaction was submitted again after it landed | reproduced | Remediation 2 |
   | 196 | `Invalid.DustDoubleSpend` | The DUST paying the fee was already spent | reproduced | Remediation 3 |
   | 170 | `Malformed.InvalidDustSpendProof` | The DUST spend proof didn't verify, which is as likely a disagreement on DUST state as a bad proof | `servicedesk#150`, `servicedesk#52` | Remediation 4 |
   | 168 | `Malformed.FeeCalculation` | Validation would take longer than the size allows, or too big for a block | `servicedesk#100`, `servicedesk#54` | Remediation 5 |
   | 186 | `Malformed.EffectsCheckFailure` | The transaction's effects don't match what its contract calls claim | `servicedesk#37` | Remediation 6 |

   On node 2.x look for their successors (table under Root cause). Anything else → Remediation 7.

## Remediation

1. **TTL (182; 228 and 229 on 2.x).** Build the transaction again and submit it promptly. Pass no
   `ttl` (the wallet's default, now + 1 hour) or one a little in the future: now + 30 minutes was
   accepted, now - 5 minutes and now + 30 days were rejected. The node log gives the limit; on
   the local network the furthest allowed TTL was block time + 14 days. The default comes from
   the machine's clock, so a client clock more than an hour behind produces expired TTLs (from
   source, not reproduced).

   *Trade-off:* a signed transaction that waits (offline signing, a queue) can expire; build it
   close to submission.
2. **Already on chain (193; 242 to 244 on 2.x).** The transaction landed; usually a retry
   resubmitted it. Look it up by the id `submitTransaction` returned before retrying (with
   midnight-js, `publicDataProvider.watchForTxData(txId)`), and treat 193 after a retry as "the
   first one went through". Submitting the same transaction again while it was still pending was
   harmless: the wallet returned the same id, no error. For a real retry, build a new
   transaction.

   *Trade-off:* safe retries need the transaction id stored before the first submission.
3. **DUST already spent (196).** Run one wallet instance per seed, submit one transaction at a time
   per wallet, and let the wallet sync its last transaction before building the next. Two
   instances on one seed built from the same state picked the same DUST; the second was rejected
   before and after the first landed, while a transaction built after the wallet synced went
   through.

   *Trade-off:* that serializes submissions. For parallel throughput, use separate wallets (seeds),
   each with its own DUST.
4. **DUST spend proof (170).** Let the wallet finish syncing and build again. If every
   transaction on the network fails with 170, faucet included, the network's DUST state is the
   problem, not the DApp: open a servicedesk issue (`servicedesk#150`, stagenet, 2026-08). If
   only your client fails, check its ledger version against the network's with the
   [toolchain version mismatch runbook](../toolchain-version-mismatch-runbook/toolchain-version-mismatch-runbook.md)
   (`servicedesk#52`). Not reproduced here.
5. **Fee check (168 on 1.0.x; 231 and 232 on 2.x).** The node log says which of two it is.
   "exceeded the maximum time to dismiss for transaction size": the transaction costs more to
   validate than its size allows, so change its shape (fewer intents or calls per transaction).
   The limit is a network parameter: `servicedesk#100`, a balanced sealed swap that gained a third
   intent, was closed as needing a governance decision. "exceeded block limit in transaction fee
   computation": the transaction is too big for a block; for a deploy, see the
   [batched deploy runbook](../contract-batched-deploy-runbook/contract-batched-deploy-runbook.md).
   `servicedesk#54` saw 168 with an 8.0.3 client on an 8.0.2 node, so check versions too. Not
   reproduced here.
6. **Effects check (186; 212 to 218 on 2.x).** On midnight-js 4.0.x, upgrade to the matrix version
   (4.1.1 at compile date): 4.0.4 put a fallible claim's offer in the guaranteed section
   (`servicedesk#37`). Otherwise open an issue with the contract and the full error. Not
   reproduced here.
7. **Anything else.** Run the decoder, read the name and category, and check the code's row on
   the Node error codes page. If that doesn't explain it, open an issue at the
   [servicedesk front door](https://github.com/midnightntwrk/servicedesk/issues/new/choose) with
   `String(err)`, the decoder's output, the node's `system_version` and, if you have them, the
   node log lines around `Rejected transaction`.

## Upstream follow-ups

- [servicedesk#225](https://github.com/midnightntwrk/servicedesk/issues/225): the SDK error that
  reaches the DApp doesn't carry the node's reason in `message`.
- midnight-docs (to file): the "Decode 1010 errors" page lists node 2.x codes as current and marks
  codes every public network returns as retired; the Node error codes page is missing 211.

## Reference material

- **Reproductions:** [`scripts/decode-1010.NOTES.md`](scripts/decode-1010.NOTES.md): every
  reproduction, how the script's tables were generated and checked, and what was not reproduced.
- **Worked cases:** `servicedesk#37` (186, midnight-js 4.0.4), `servicedesk#52` (170, client
  ledger version), `servicedesk#54` (168, 8.0.3 client on an 8.0.2 node), `servicedesk#100` (168,
  three-intent swap), `servicedesk#117` (231 on a node 2.0.0-rc.4 devnet), `servicedesk#150` (170
  for every transaction on stagenet), `servicedesk#225` (1010 "would exhaust the block limits"),
  `servicedesk#235` (the 182 TTL text in a node's log while replaying history).
- **Docs:** [Node error codes](https://docs.midnight.network/nodes/error-codes) (1.0.x table and
  how the SDK wraps the error), [Decode 1010 errors](https://docs.midnight.network/how-to/decode-1010-transaction-rejection-errors)
  (2.x table).
- **Source:**
  - midnight-node `node-1.0.400`: [`ledger/src/versions/common/types.rs` L277-419](https://github.com/midnightntwrk/midnight-node/blob/3acfd2edecdcd91373b6a506933f4c14ad3f0308/ledger/src/versions/common/types.rs#L277-L419),
    [`pallets/midnight/src/lib.rs` L557-558](https://github.com/midnightntwrk/midnight-node/blob/3acfd2edecdcd91373b6a506933f4c14ad3f0308/pallets/midnight/src/lib.rs#L557-L558)
  - midnight-node `node-2.1.0-rc.4`: [`ledger/src/ledger_8/types.rs` L359-556](https://github.com/midnightntwrk/midnight-node/blob/1b2b31c714f8986a082b8690f15e805981c771dd/ledger/src/ledger_8/types.rs#L359-L556)
  - midnight-ledger `ledger-8.1.2`: [`ledger/src/error.rs`](https://github.com/midnightntwrk/midnight-ledger/blob/36d7442172136758e33009f75ff4aa56616cff40/ledger/src/error.rs)
    (`FeeCalculationError`, `TransactionApplicationError`, `InvalidDustSpendProof` texts)
  - polkadot-sdk `polkadot-stable2603`: [`substrate/client/rpc-api/src/author/error.rs` L107-111](https://github.com/paritytech/polkadot-sdk/blob/2e4dd0bc22366a5af820492528869a493b5a5208/substrate/client/rpc-api/src/author/error.rs#L107-L111)
  - `effect` 3.22.0 `internal/runtime.ts` (`FiberFailureImpl.toString`); `wallet-sdk-facade`
    4.1.0 `dist/index.js` (`DEFAULT_TTL_MS`); midnight-js 4.1.1 `packages/contracts`
    (`Unexpected error submitting scoped transaction`, `watchForTxData`)
