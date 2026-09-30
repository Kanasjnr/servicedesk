# Runbook: Deploying a contract too large for one block ("exceeded block limit in transaction fee computation")

A Compact contract with many exported circuits **cannot be deployed**. `deployContract()` fails
while the deploy transaction is balanced or priced, before anything lands on chain, because the
deploy carries one verifier key per circuit and together they exceed the **per-block
bytes-written limit**. Use this runbook to confirm that this is the cause. The fix is to deploy in
batches: deploy the contract with the keys that fit, then add the rest one at a time with signed
maintenance updates.

_Compiled 2026-09-29 from source investigation. Source was read at midnight-js `v4.1.1`
(`5f8a5d14247cb238b52187f33ed31695a5fde85d`), midnight-ledger `ledger-8`
(`9f9842ebed66cdff0f54d3fb09efc6a7cd077ed8`), midnight-node
(`eaecadc03efd06464bcf1dbaf2c7c770967ae9e9`) and the npm packages `@midnight-ntwrk/compact-js@2.5.1`
and `@midnight-ntwrk/ledger-v8@8.1.0`. Costs were measured with the ledger's own cost model. The
whole batched flow was run end to end against a local `ledger-v8` `LedgerState`: subset deploy,
24 key inserts, and replay, duplicate and wrong-key cases. **It has not yet been run against a
live node.** Do the first real run on preview or preprod before mainnet. Verify line references
and versions against current source before asserting anything, because the Midnight ecosystem
changes fast._

---

## Symptom

- `deployContract(providers, { compiledContract, ... })` (or `submitDeployTx`) throws while the
  wallet is balancing the transaction or paying its fee. The message is:
  `exceeded block limit in transaction fee computation`
  (ledger `FeeCalculationError::BlockLimitExceeded`, node code **155**). Nothing is submitted
  and no contract address appears on chain.
- The contract compiles fine, and small contracts deploy fine from the same wallet and setup.
  The failing contract has **many exported circuits**, roughly 20 or more for typical circuits.
- Other errors in the same family, depending on which limit is hit and where:
  - `transaction too large (size: N, limit: 1048576)`: `MalformedTransaction::TransactionTooLarge`,
    node code **111**. This only happens for very large contracts, around 500 or more circuits;
    the bytes-written limit is reached long before this one.
  - `exceeded block limit during transaction application` (node code 155) or
    `exceeded block limit during post-block update declaration` (node code 154). These come from
    the node side.
- **Not this runbook:** a deploy that **hangs**, with the CPU pinned and memory growing, and
  never returns an error. That is the
  [WalletFacade DUST balancing hang](../wallet-dust-balancing-hang-runbook/wallet-dust-balancing-hang-runbook.md).
  That problem can also hit deploys whose constructor mints a token.

## Root cause

1. **Every circuit's verifier key goes into the deploy.** compact-js `ContractExecutable.initialize`
   loops over every provable circuit ID and writes each one's verifier key into the initial
   `ContractState` (`compact-js/dist/esm/effect/ContractExecutable.js` in 2.5.1, around line 79:
   `Failed to find a verifier key for circuit ...`). midnight-js `deployContract` →
   `submitDeployTx` → `createUnprovenDeployTx` (`packages/contracts/src/unproven-deploy-tx.ts`)
   has **no option to deploy only some circuits**. `DeployContractOptionsBase` offers only
   constructor args, `signingKey` and `additionalCoinEncPublicKeyMappings`.
2. **The per-block `bytesWritten` limit is small.** Mainnet, preprod, preview, qanet and devnet
   all use the same limits (`midnight-node/res/<net>/ledger-parameters-config.json`):

   | limit | value |
   |---|---|
   | `transaction_byte_limit` | 1,048,576 B (per tx) |
   | `block_limits.bytesWritten` | **50,000** (per block) ← the one that binds |
   | `block_limits.blockUsage` | 1,000,000 |
   | `block_limits.bytesChurned` | 50,000,000 |
   | `block_limits.readTime` / `computeTime` | 2 s each (2e12 ps) |

   Fee computation (`Transaction::fees` → `normalize(block_limits)`) refuses any transaction whose
   cost exceeds a whole block (`ledger/src/structure.rs` around line 1841). A deploy writes about
   **1.2 × its verifier-key bytes**.

   Measured with a 40-circuit test contract (compiler 0.31.1, keys of 1,351–2,119 B, 69,400 B in
   total):

   | circuits in deploy | tx bytes | `bytesWritten` |
   |---|---|---|
   | 20 | 36,011 | 42,496 |
   | 25 | 46,080 | 54,584 (**over the limit**) |
   | 40 | 71,593 | 84,182 (**over the limit**) |
3. **The ledger itself allows deploying a subset.** A deploy may contain only some operations
   (circuits). `ContractState::well_formed` requires only that the maintenance-authority counter
   is 0 and that every operation present has a key; a missing key gives `VerifierKeyNotSet`,
   code 110 (`ledger/src/verify.rs` lines 354–391). The remaining keys can be added later with a
   `MaintenanceUpdate` carrying `VerifierKeyInsert` entries, signed by the **contract
   maintenance authority (CMA)** (`ledger/src/structure.rs` lines 2687–2749,
   `ledger/src/semantics.rs` lines 1472–1522). midnight-js exposes this as
   `submitInsertVerifierKeyTx`, which inserts **one** circuit per tx
   (`packages/contracts/src/governance/submit-insert-vk-tx.ts` lines 73–103). A single insert
   costs a fixed **3,003 `bytesWritten`**, because the cost model charges a flat
   `VERIFIER_KEY_SIZE`. So each insert tx always fits.

The SDK is not defective here. It simply has no batch mode, so the batching has to be done by
hand. This runbook and its companion script do that.

## Key identifiers

- **Packages** (as of compile date): `@midnight-ntwrk/midnight-js-contracts@4.1.1`, plus
  `-types`, `-protocol`, `-network-id` and `-utils` at 4.1.1. These bundle `compact-js@2.5.1`,
  `compact-runtime@0.16.0` and `ledger-v8@8.1.0`. The matching compiler is Compact 0.31.x, whose
  output checks `checkRuntimeVersion('0.16.0')`.
- **SDK functions used:**
  - `createUnprovenDeployTx`
  - `submitTx`
  - `submitInsertVerifierKeyTx`
  - `findDeployedContract`
  - `createCircuitCallTxInterface`
  - error classes `DeployTxFailedError` and `InsertVerifierKeyTxFailedError`
  - private-state provider calls `setSigningKey` and `getSigningKey`
- **Ledger types** (`@midnight-ntwrk/midnight-js-protocol/ledger`): `ContractDeploy`
  (address = SHA-256 of the tagged deploy, **including a random nonce**), `ContractState`,
  `MaintenanceUpdate`, `VerifierKeyInsert`, `ContractOperationVersionedVerifierKey('v3', vk)`, and
  `Transaction.cost(params)`, which returns a `SyntheticCost`.
- **Default CMA:** a one-key committee with **threshold 1** (`DEFAULT_CMA_THRESHOLD = 1` in
  compact-js 2.5.1). The key is sampled by `sampleSigningKey()` unless you pass one.
- **Node error codes** (`midnight-node/ledger/src/ledger_{8,9}/types.rs`):

  | code | error |
  |---|---|
  | 107 | `VerifierKeyAlreadyPresent` |
  | 108 | `ReplayCounterMismatch` |
  | 110 | `VerifierKeyNotSet` |
  | 111 | `TransactionTooLarge` |
  | 113 | `VerifierKeyNotPresent` |
  | 135 | `InvalidCommitteeSignature` |
  | 136 | `ThresholdMissed` |
  | 154 | block limit (post-block update) |
  | 155 | fee calculation / block limit |
- **Compiler output:** `<out>/keys/<circuit>.verifier` holds one file per provable circuit. These
  are the bytes that go into the deploy.

## Diagnose (no API key, no node)

1. **Count the circuits and size the keys** from the compiler output. Do not compile with
   `--skip-zk`, because that produces no keys.

   ```sh
   ls <out>/keys/*.verifier | wc -l
   du -cb <out>/keys/*.verifier | tail -1    # total VK bytes; > ~40,000 is suspect
   ```
2. **Price the deploy exactly** with [`scripts/measure-deploy-cost.mjs`](scripts/measure-deploy-cost.mjs).
   It needs no wallet, node or API key, and nothing is signed.

   ```sh
   mkdir /tmp/measure && cd /tmp/measure && npm i @midnight-ntwrk/ledger-v8@8.1.0
   cp <this-repo>/runbooks/contract-batched-deploy-runbook/scripts/measure-deploy-cost.mjs .
   node measure-deploy-cost.mjs <out>            # exit 1 = does not fit
   # optional: other network's limits
   curl -sO https://raw.githubusercontent.com/midnightntwrk/midnight-node/main/res/mainnet/ledger-parameters-config.json
   node measure-deploy-cost.mjs <out> --params ledger-parameters-config.json
   ```

   Example output for the 40-circuit test contract:

   ```text
   bytesWritten 83261 (block limit 50000)
   RESULT: DOES NOT FIT in one block — exceeds: bytesWritten 83261 > 50000
   first deploy can carry up to 16 verifier keys          (at 80% headroom)
   => 1 deploy tx + 24 single-insert txs
   ```

   The script uses an empty initial ledger state, so the real deploy costs slightly more (the
   constructor's ledger data is about 1.3 KB of `bytesWritten` for a small ledger). Keep the
   headroom.
3. If the result is "fits", the problem is something else. Check the DUST hang runbook, wallet
   funding, and the proof server.

## Remediation options (least invasive first)

1. **Shrink the deploy (no batching needed).** Only *exported, impure* circuits get verifier
   keys. Non-exported helpers and `export pure circuit`s get none (checked with compiler 0.31.1).
   - Make helpers non-exported, or make them `pure` where the logic doesn't touch the ledger.
   - Merge near-duplicate entry points into one circuit with a selector argument.
   - Re-run the diagnostic.

   *Trade-off:* changes the contract API; merged circuits may cost more to prove.
2. **Batched deploy: deploy a subset, then insert the remaining keys.** Use
   [`scripts/batch-deploy.ts`](scripts/batch-deploy.ts); see
   [`batch-deploy.NOTES.md`](scripts/batch-deploy.NOTES.md) for setup. The user runs it
   **locally** with their own providers; nobody else ever handles their keys.
   1. **Dry run first** (the default). It runs the constructor locally, builds the full deploy
      tx, then shrinks the tx to the largest set of circuits that fits within 80% of the block
      limits (`priorityCircuits` go first). It prints the plan and submits nothing.
   2. **Execute** (`execute: true`).
      - **Batch 1:** the subset deploy. The CMA signing key is saved to the private state
        provider under the new address **before** submitting, and the address is printed.
      - **Batches 2..N:** `submitInsertVerifierKeyTx` runs once per remaining circuit,
        sequentially. On-chain state is re-checked before each insert.
   3. **If it is interrupted**, re-run with `contractAddress: '<printed address>'`. It compares
      the on-chain operations with the compiled circuits and inserts only the missing ones. It
      stops if a circuit on chain has a *different* key, which means the contract was
      recompiled; see the caveats below.
   4. **When all keys are in**, use `findDeployedContract()` as normal.

   *Trade-off:* 1 + (N − fit) transactions, each paying DUST fees, and they must run one after
   another (see the caveats).
3. **Split into several contracts.** Move groups of circuits into separate contracts that call
   each other or share state by design.

   *Trade-off:* this is a redesign, with cross-contract calls and shared-state concerns. It is
   only worth it if the contract would keep growing.
4. **Optimization, not in the script: several inserts per maintenance tx.** The ledger accepts
   many `VerifierKeyInsert`s in one `MaintenanceUpdate` (tested in
   `ledger/tests/maintenance.rs` around lines 325–345). About 13 keys fit per tx at 80%
   headroom, since each costs a flat ~2.9 KB of `bytesWritten`. midnight-js 4.1.1 has **no API**
   for this, so you would have to sign the update yourself with the tagged CMA key. Only do it if
   the transaction count really matters.

### Operational caveats (read before `execute: true`)

- **The CMA signing key is the only way to finish the deploy.** It lives in the private state
  provider under the contract address (`getSigningKey(address)`). If it is lost after batch 1,
  the missing circuits can **never** be added and you have to redeploy. Back up the private
  state store, or pass your own `signingKey` and keep it safe. Never send it to anyone.
- **Until all keys are in, the contract is partly usable:**
  - Calling a circuit without a key is rejected with
    `operation <addr>/<circuit> does not have a verifier key` (`VerifierKeyNotPresent`, 113).
  - `findDeployedContract()` throws `ContractTypeError` because `verifyContractState` requires
    every compiled circuit on chain (`packages/contracts/src/find-deployed-contract.ts` lines
    120–135 and 271–274).
  - To call circuits before everything is in, build the interface directly with
    `createCircuitCallTxInterface(providers, compiledContract, address, privateStateId)`.
  - Use `priorityCircuits` to deploy admin, pause or initialisation circuits first. Don't
    announce the address until the final insert has landed.
- **Batches must run in order, one at a time.** Each maintenance update signs the current CMA
  counter, which goes up by one on success. A second update that is in flight at the same time
  lands **on chain as a partial success, and its fee is still paid**, with
  `the signed counter for ... did not match the expected one; likely replay attack` (108). Don't
  run two copies of the script against the same address.
- **An insert never overwrites a key.** Inserting a circuit that already has a key is a partial
  success with `the verifier key for <c> version V3 was already present` (107), and the fee is
  still paid. The script's on-chain check before each insert avoids this. To *change* a key, run
  `submitRemoveVerifierKeyTx` first and then insert.
- **Recompiling in the middle of a deploy changes the keys.** If you recompile (for example with
  a new compiler version) between batches, the keys already on chain won't match the new ones.
  The script refuses to continue in that case. Either finish with the original build artefacts,
  or remove and re-insert the mismatched circuits (the remove costs one more maintenance tx each).
- **A wrong CMA key is rejected up front** (`InvalidCommitteeSignature` / well-formedness
  failure). No fee is paid, but nothing progresses.
- **The address is only known at execute time.** It includes a random nonce, so the dry-run
  address is **not** the real one. Use the address printed by the `execute: true` run.

## Reference material

- **Source** (refs in the header):
  - midnight-js `packages/contracts/src/`:
    - `unproven-deploy-tx.ts` (`createUnprovenDeployTxFromVerifierKeys`)
    - `utils/ledger-utils.ts` (`createUnprovenLedgerDeployTx`, which is not exported)
    - `submit-deploy-tx.ts`
    - `deploy-contract.ts`
    - `governance/submit-insert-vk-tx.ts`
    - `governance/unproven-tx.ts`
    - `find-deployed-contract.ts`
  - compact-js `src/effect/ContractExecutable.ts`: `initialize`, `addOrReplaceContractOperation`,
    `createSignedMaintenanceUpdate`, `createMaintenanceAuthority`.
  - midnight-ledger `ledger/src/`:
    - `structure.rs` (`ContractDeploy`, `SingleUpdate`, `MaintenanceUpdate`, `INITIAL_LIMITS`,
      and the fee/normalize logic around lines 1840–1860)
    - `verify.rs` (deploy and maintenance well-formedness)
    - `semantics.rs` (applying updates)
    - `error.rs` (display strings)
  - midnight-ledger tests: `ledger/tests/maintenance.rs`.
  - midnight-node: `res/<net>/ledger-parameters-config.json` (limits) and
    `ledger/src/ledger_{8,9}/types.rs` (error codes).
- **SDK tests to crib from:**
  - midnight-js `packages/contracts/src/test/governance/*.test.ts`
  - `testkit-js/testkit-js-e2e/test/contracts.snarkupgrade*.it.test.ts` (live insert and
    remove of keys)
- **Changelog context:** compact-js #182 ("Add contract maintenance operations to
  `ContractExecutable`"). At compile date there is **no** upstream batch-deploy feature, PR or
  issue in midnight-js or compact-js.
- **Related, but a different problem:**
  [WalletFacade balance/finalization hang](../wallet-dust-balancing-hang-runbook/wallet-dust-balancing-hang-runbook.md),
  where a deploy hangs instead of failing with a block-limit error.
