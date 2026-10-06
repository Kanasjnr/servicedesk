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
| [Migrating from the official indexer/RPC to Blockfrost](indexer-blockfrost-migration-runbook/indexer-blockfrost-migration-runbook.md) | Switching mainnet (official endpoints shut down 2026-09-30) or preprod to Blockfrost: URL and `project_id` changes, and wallet sync stuck on "values inserted non-linearly into dust generation tree" because event ids differ between indexers, so saved cursors and preseed bundles don't carry over; and "Wallet sync timeout" right after funding, because Blockfrost's indexer backs off unshielded progress updates on idle subscriptions; and how to tell which indexer a preseed bundle was cut against. |
| [Batched deploy for oversized contracts](contract-batched-deploy-runbook/contract-batched-deploy-runbook.md) | Deploy fails with "exceeded block limit in transaction fee computation", or is rejected with RPC 1010 "Transaction would exhaust the block limits" (SDK: "Transaction submission error"), because every circuit's verifier key rides in the deploy and a tx may use only ~65% of the 50 KB/block `bytesWritten` limit. Fix: deploy a subset, then insert the remaining keys via maintenance updates. |
| [Toolchain and package version mismatch](toolchain-version-mismatch-runbook/toolchain-version-mismatch-runbook.md) | Contract import, deploy or proving fails before submission ("Version mismatch: compiled code expects …", "Failed to configure constructor context with coin public key", "expected instance of ContractMaintenanceAuthority", "export named 'Clock'", proof server `400` on `/check`) because the compiler, runtime, wallet SDK or ZKIR format isn't the network-supported set (the newest compiler and runtime are ahead of every network), or the contract and midnight-js load different on-chain runtime copies. |
| [Node rejection codes (1010 "Custom error: N")](node-1010-custom-error-runbook/node-1010-custom-error-runbook.md) | Submission fails with only "Transaction submission error": the node's reason, `1010: Invalid Transaction: Custom error: N`, is in `String(err)` and the `RPC-CORE` console line but not `err.message`. N is a node-version-specific code (node 2.x drops or renames ten of node 1.0.x's, and the docs' "Decode 1010 errors" page lists the 2.x table); decode it with the script and fix the common ones: 182 intent TTL, 193 already on chain, 196 DUST already spent, 170 DUST proof, 168 fee/time to dismiss, 186 effects check. |

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
  directory).
- **Companion scripts** live in a `scripts/` subdirectory of the runbook's own directory
  and are linked from the runbook that uses them. A script meant to run inside another repo
  must say where it goes and keep any relative imports valid for that location.
