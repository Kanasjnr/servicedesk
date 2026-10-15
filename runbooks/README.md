# Runbooks

Reusable diagnosis-and-fix guides for recurring Midnight ecosystem issues — written to
be picked up by a human or an AI agent mid-incident. Each runbook is self-contained:
symptom, root cause, key identifiers, a runnable diagnostic (prefer no-API-key where
possible), remediation options, and links to source/specs/tracking issues.

**Agents:** read [AGENTS.md](AGENTS.md) first — separate guidance for agents resolving an
issue on behalf of a user vs. MNF/STL accounts triaging and authoring runbooks.

## Index

| Runbook | Covers |
|---|---|
| [cNIGHT→DUST duplicate registrations](cnight-dust-duplicate-registration-runbook/cnight-dust-duplicate-registration-runbook.md) | "DUST stopped generating" / balance 0 caused by 2+ live registration UTXOs for one Cardano stake key (DApp filter bug). |
| [WalletFacade balance/finalization hang](wallet-dust-balancing-hang-runbook/wallet-dust-balancing-hang-runbook.md) | Balance/finalize never returns — CPU-bound, unbounded RSS growth — from a non-terminating DUST fee-balancing loop, triggered by minting a new custom shielded token. |
| [Migrating from the official indexer/RPC to Blockfrost](indexer-blockfrost-migration-runbook/indexer-blockfrost-migration-runbook.md) | Switching mainnet (official endpoints scheduled to shut down; still answering 2026-10-07) or preprod to Blockfrost: URL and `project_id` changes, the event-id offsets measured between the official indexer and Blockfrost, preseed bundles, and "Wallet sync timeout" right after funding, because Blockfrost's indexer backs off unshielded progress updates on idle subscriptions; and how to tell which indexer a preseed bundle was cut against. |
| [Batched deploy for oversized contracts](contract-batched-deploy-runbook/contract-batched-deploy-runbook.md) | Deploy fails with "exceeded block limit in transaction fee computation", or is rejected with RPC 1010 "Transaction would exhaust the block limits" (SDK: "Transaction submission error"), because every circuit's verifier key rides in the deploy and a tx may use only ~65% of the 50 KB/block `bytesWritten` limit. Fix: deploy a subset, then insert the remaining keys via maintenance updates. |
| [Toolchain and package version mismatch](toolchain-version-mismatch-runbook/toolchain-version-mismatch-runbook.md) | Contract import, deploy or proving fails before submission ("Version mismatch: compiled code expects …", "Failed to configure constructor context with coin public key", "expected instance of ContractMaintenanceAuthority", "export named 'Clock'", proof server `400` on `/check`) because the compiler, runtime, wallet SDK or ZKIR format isn't the network-supported set (the newest compiler and runtime are ahead of every network), or the contract and midnight-js load different on-chain runtime copies. |
| [Proof server and proving failures](proof-server-proving-failures-runbook/proof-server-proving-failures-runbook.md) | A deploy or call fails while proving: midnight-js `'check'`/`'prove' returned an error` (`ECONNREFUSED`/`ECONNRESET …:6300`, `Failed Proof Server response` with code 400, 404, 429 or 500, `AbortError: The user aborted a request.`) or the wallet's `(FiberFailure) Wallet.Proving: Failed to prove transaction`. Causes: a proof server still downloading its keys or exited after `Failed to fetch data … Giving up.`, flags lost to the image's `bash -c` entrypoint, a port nothing listens on, a wrong URL, a 400 whose reason is only in the verbose log, job capacity, timeouts, memory. Checker with a test proof. |
| [Node rejection codes (1010 "Custom error: N")](node-1010-custom-error-runbook/node-1010-custom-error-runbook.md) | Submission fails with only `(FiberFailure) SubmissionError: Transaction submission error`. The node's reason, `1010: Invalid Transaction: Custom error: N`, is in `String(err)` and the `RPC-CORE` console line, not `err.message` (midnight-js contract calls do include it), and N depends on the node version (node 2.x renumbers ten codes; preview, preprod and mainnet run 1.0.400). Decoder script, and fixes for 182 intent TTL, 193 already on chain, 196 or `TransactionInvalidError` DUST already spent, 170 DUST proof, 168 fee checks, 186 effects check. |
| [AI-written SDK code that won't install, compile or load](sdk-ai-generated-code-errors-runbook/sdk-ai-generated-code-errors-runbook.md) | DApp TypeScript from an AI assistant fails at `npm install` (`No matching version found for @midnight-ntwrk/compact-js@2.0.0`, `404 Not Found`), in `tsc` (`has no exported member`, `Constructor of class 'WalletFacade' is private`, `Property 'walletBalance' does not exist`) or on import (`checkRuntimeVersion is not a function`). The assistant wrote against the SDK generation before the network set (midnight-js 3.0.0, `@midnight-ntwrk/wallet`, `ledger-v7`), imported moved, renamed or invented names, or used the pre-4.0 DApp connector, whose 4.0.1 types are silently `any` under NodeNext. Read-only checker that names the replacement for each line, plus `--explain` for a pasted error; tested on a 30-file AI corpus and on maintained examples. |
| [Wallet sync on Preprod: slow, repeated on every restart, or stuck](wallet-preprod-sync-runbook/wallet-preprod-sync-runbook.md) | A wallet sits on `Waiting to receive tokens...` for an hour or more although the example promised a minute or two, pays the same hour again after every restart, or stops moving while still reporting itself connected (`Wallet.Sync: [object ErrorEvent]`, `RPC-CORE: … Normal Closure`, `appliedIndex` far below the block height, `values inserted non-linearly into dust commitment tree`). A fresh wallet replays every DUST event on the chain (about 1.6 million on Preprod), nothing is kept unless the app saves state, and in wallet SDK 1.2.0 a sync can stop after the machine sleeps and not start again. Read-only checker for the indexer and saved state files, a watcher that tells slow from stuck, and save/restore, snapshot and restart remediations; both scripts tested offline. |
| [Self-hosted node or indexer stops on a block the chain accepted](node-indexer-sync-halt-runbook/node-indexer-sync-halt-runbook.md) | A self-hosted indexer, or a node syncing from genesis, stops with `Intent TTL has expired` or `dust is outside of its validity window` (indexer: `index_blocks_task failed: … cannot apply regular transaction`; node: `Invalid(Custom(182)). Aborting the rest of the block execution`), and stops there again after every restart. A block's first transaction is valid at its block's time or at the parent's time + 12 s, and the version checks the other one: indexer v4.3.3 and older, v4.3.4, v4.3.5 to v4.3.800-rc.1 and v4.4.0-rc.x, node 1.0.300. Since each network's runtime 1.0.300 upgrade, indexers that add 12 s to every block can stop on new blocks too. Known blocks on Preview, Preprod and Mainnet; checker that finds the block, names the pattern and lists the releases with the fix (indexer 4.3.800-rc.2, node 1.0.400), and the in-place upgrade steps. |

## Conventions for adding a runbook

- **One directory per runbook.** Each runbook gets its own second-level directory,
  `<area>-<short-topic>-runbook/`, holding the runbook file and every supporting asset —
  so all material for an issue stays self-contained. The runbook file inside it keeps the
  same name: `<area>-<short-topic>-runbook/<area>-<short-topic>-runbook.md` (kebab-case).
- **Structure:** Symptom → Root cause → Key identifiers → Diagnose (script/steps) →
  Remediation options → Reference material (source, specs, issues, worked cases).
- **Verify before asserting.** Midnight moves fast; treat code line references and
  version-specific claims as point-in-time. Note the compile date and re-verify against
  current source. Prefer verified source/on-chain evidence over recalled knowledge.
- **Never take user keys or seed phrases.** Remediations that require signing must be run
  by the affected user locally; provide the script, not a request for their secrets.
- **Add a row to the Index above** when you add a runbook (link to the file inside its
  directory), and add its exact error strings to the **Error-string lookup**.
- **Companion scripts** live in a `scripts/` subdirectory of the runbook's own directory
  and are linked from the runbook that uses them. A script meant to run inside another repo
  must say where it goes and keep any relative imports valid for that location.
