# Notes: running `batch-deploy.ts`

How to set up and run the batched deploy from
[contract-batched-deploy-runbook](../contract-batched-deploy-runbook.md), and what was verified
before it was handed out. **The user runs it**, in their own DApp repo, with their own wallet and
providers. Never ask for their seed, wallet file or CMA signing key.

## Where it goes

Copy `batch-deploy.ts` into the DApp repo that already deploys the contract, next to the code that
builds `ContractProviders` and calls `deployContract`. It imports only published packages, so no
relative imports need fixing:

- `@midnight-ntwrk/midnight-js-contracts`
- `@midnight-ntwrk/midnight-js-protocol` (`/ledger`, `/compact-js`, `/compact-runtime`)
- `@midnight-ntwrk/midnight-js-types`

It was written and type-checked against **midnight-js 4.1.1**. On another version, re-check the
imports and signatures listed under "Re-verify when versions move".

## Usage

Replace the `deployContract` call with this:

```ts
import { batchDeploy } from './batch-deploy';

// 1. Dry run (default) — prints the plan, submits nothing, touches no private state.
await batchDeploy(providers, {
  compiledContract,                 // same CompiledContract you pass to deployContract
  args: [/* constructor args */],
  // privateStateId / initialPrivateState — same as deployContract, if the contract has private state
  priorityCircuits: ['pause', 'setAdmin'], // optional: deploy these first
});

// 2. Real run.
const r = await batchDeploy(providers, { compiledContract, args: [...], execute: true });

// 3. If interrupted: resume with the address printed by step 2.
await batchDeploy(providers, { compiledContract, contractAddress: '<addr>', execute: true });

// 4. Afterwards, as normal:
const contract = await findDeployedContract(providers, { compiledContract, contractAddress: r.contractAddress! });
```

Options:

- `budget` overrides the network limits. The default is `MAINNET_BUDGET`, with `headroom: 0.8`.
  Preview, preprod and qanet used the same limits at compile date.
- `signingKey` sets your own CMA key (see the runbook caveats).
- `log` redirects the output.

**Test on preview or preprod first.** Mainnet transactions cost real DUST.

## What the script does, precisely

1. It reads every provable circuit ID (`ContractExecutable.make(compiledContract).getProvableCircuitIds()`)
   and its key (`zkConfigProvider.getVerifierKeys`).
2. It calls the SDK's `createUnprovenDeployTx`. This runs the constructor locally and builds the
   full deploy tx, with every key, without submitting it.
3. It **rewrites that tx in place** (`restrictDeployTo`):
   - It builds a new ledger `ContractState` holding the constructor's `data`,
     `maintenanceAuthority` and `balance`, plus only the chosen operations.
   - It wraps that state in a fresh `ContractDeploy`, swaps it into the intent, and reassigns
     `tx.intents`. The tx is unproven and unbound, so the binding is recomputed.
   - The Zswap offers built by the SDK are kept unchanged, so constructor-minted coins still work.
4. It adds circuits one by one while `tx.cost(LedgerParameters.initialParameters())` and the tx
   size stay within `headroom × limit`. It compares against the limits in `budget`, not the ones
   in `initialParameters`, whose `blockUsage` is lower than mainnet's.
5. With `execute: true`:
   1. It saves the signing key (`setContractAddress` + `setSigningKey`) **before** the deploy is
      submitted.
   2. It submits with `submitTx` (the same path `submitDeployTx` uses: prove → balance → submit)
      and throws `DeployTxFailedError` on anything other than `SucceedEntirely`.
   3. It then stores the private state.
   4. It calls `submitInsertVerifierKeyTx` for each remaining circuit, one at a time.

## Verified before hand-off (2026-09-29, offline)

- `tsc --strict` type-check against the midnight-js 4.1.1 npm packages: clean.
- A 40-circuit test contract (compiler 0.31.1). Its full deploy costs `bytesWritten` 84,182, over
  the 50,000 limit, and `tx.fees()` throws `exceeded block limit in transaction fee computation`.
- **Ledger simulation** (`ledger-v8` 8.1.0 `LedgerState` + `wellFormed` + `apply`, with proof and
  balance checks off and signatures checked):
  - A 16-circuit subset deploy from `restrictDeployTo` succeeds, with the counter at 0.
  - 24 sequential single-key maintenance updates all succeed. At the end, all 40 operations are
    on chain, every key is byte-identical to the compiled one, and the counter is 24.
  - Stale counter → `partialSuccess` ("signed counter … did not match").
  - Duplicate insert → `partialSuccess` ("… was already present"), and the counter does not move.
  - Wrong key → rejected at well-formedness ("signature for key id 0 invalid").
- The module's own `batchDeploy`, run with stub providers:
  - Dry run: an 18-circuit first batch with 2 priority circuits, stopping at `bytesWritten`
    40,782 > 40,000. No provider write or submit method is called.
  - Resume against a partial state inserts only the missing circuits, and against a complete state
    inserts nothing.
  - A mismatched on-chain key aborts, and a missing CMA key aborts.

**Not yet verified:** a run against a live node, including real proving, wallet balancing and
indexer reads. Do the first run on preview or preprod, and add its tx hashes to this file.

## Re-verify when versions move

- midnight-js still exports `createUnprovenDeployTx`, `submitTx`, `submitInsertVerifierKeyTx` and
  `DeployTxFailedError` from `@midnight-ntwrk/midnight-js-contracts`.
- `deployContract` still has no batch option. If one appears upstream, use it and retire this
  script.
- Ledger `Intent.actions`, `Transaction.intents` (setter), `ContractState` (`data`,
  `maintenanceAuthority`, `balance`, `setOperation`) and `Transaction.cost` keep their shapes.
- The network limits in `midnight-node/res/<net>/ledger-parameters-config.json`, especially
  `bytesWritten`.
