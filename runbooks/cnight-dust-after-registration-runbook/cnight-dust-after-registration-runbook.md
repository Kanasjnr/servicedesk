---
title: "DUST doesn't arrive after registering cNIGHT"
when_to_use: 'cNIGHT was registered for DUST in the cNgD DApp and no DUST has arrived, the DApp stays on "Registration Syncing" or says "NO REGISTRATION FOUND", or the DApp, the wallet and the indexer show different DUST figures.'
audience: "developers support-agents"
owner: "mn-servicedesk"
compiled: "2026-10-22"
last_reviewed: "2026-10-22"
error_strings:
  - "Registration Syncing"
  - "NO REGISTRATION FOUND"
  - '"registered": false'
review_when:
  - "NIGHT can be held on Midnight Mainnet itself: NIGHT held there registers with a Midnight transaction, which this runbook does not cover"
  - "The indexer's dustGenerationStatus starts counting every UTXO that generates for a DUST address: drop Root cause 5, Diagnose 4's DApp step and the script's DAPP note"
---

# Runbook: DUST doesn't arrive after registering cNIGHT

A cNIGHT registration links a Cardano stake key to a Midnight DUST address, and Midnight generates DUST from the cNIGHT that key holds. DUST can be missing because the registration hasn't reached Midnight yet, because it was removed or duplicated, because it names another DUST address, or because the cNIGHT moved. A read-only script reads both chains and names which one it is.

Each fact is in Key identifiers with its source. A claim marked **measured**, **reported**, **inferred** or **not tested** has none, so trust it less.

## Symptom

| If you see | Go to |
|---|---|
| The cNgD DApp shows `Registration Syncing` | Diagnose 1 |
| The DApp shows `NO REGISTRATION FOUND` for a wallet that registered | Diagnose 1 |
| A DUST balance of 0 hours or days after registering | Diagnose 1 |
| The indexer answers `"registered": false` for the wallet's reward address | Diagnose 1 |
| The DApp, the wallet and the indexer show different DUST figures | Diagnose 1, then Diagnose 4 |

### Not this runbook

- **Two or more registrations for one stake key.** The script says so and sends you to the [cNIGHT→DUST duplicate registrations runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/cnight-dust-duplicate-registration-runbook/cnight-dust-duplicate-registration-runbook.md), which owns the fix.
- **tNIGHT from a Preview or Preprod faucet with no DUST.** Faucet tNIGHT is on Midnight and registers with a Midnight transaction. See the [test funds runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/wallet-test-funds-runbook/wallet-test-funds-runbook.md).
- **The wallet has DUST but transactions hang while balancing.** See the [WalletFacade balancing hang runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/wallet-dust-balancing-hang-runbook/wallet-dust-balancing-hang-runbook.md).

## Root cause

1. **Midnight sees a registration only after it settles on Cardano.** Until then the indexer answers `registered: false` and the DApp shows `Registration Syncing`. The docs give about 12 hours on Mainnet, and the DApp says 2.5 hours on Preview. Every Mainnet registration up to 11.3 hours old was not yet seen, and every one from 14.7 hours was (**measured**, see the pull request). cNIGHT that reaches a registered key is counted after the same kind of wait (**inferred**).
2. **The DApp can show a registration that is gone.** It shows `Registration Syncing` whenever it holds a registration UTXO and the indexer says `registered: false`. If the registration was removed, the indexer is right and the page is stale.
3. **Midnight counts one registration per stake key.** With two or more live, the key counts as unregistered. One registration generates DUST for the DUST address written in it, which may not belong to the wallet the user is looking at.
4. **DUST comes from the cNIGHT the key holds now.** cNIGHT moved to a wallet with another stake key stops generating for this registration.
5. **The DApp's figures can count only part of the NIGHT.** Its Generation Rate, and its DUST Balance when no Midnight wallet is connected, come from the indexer's `dustGenerationStatus`, which reads only the newest UTXO generating for the DUST address. A key whose cNIGHT sits in several UTXOs sees a lower rate than it earns. `dustGenerations` adds them all up.

## Before you start

- **You need** Node 18 or newer and [scripts/check-dust-registration.mjs](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/cnight-dust-after-registration-runbook/scripts/check-dust-registration.mjs), downloaded and run from its folder. It needs no `npm install`. Give it the Cardano wallet's stake address (`stake1…`) or one of its addresses that starts `addr1q`, and, if you have it, the DUST address the user expects DUST in (`mn_dust1…`). All of these are public.
- **On Mainnet and Preprod, a Blockfrost project id** for that Midnight network, which the user creates as [Getting a Blockfrost project token](https://docs.midnight.network/guides/networks-and-environments#getting-a-blockfrost-project-token) describes and sets in their own shell: `export BLOCKFROST_PROJECT_ID=...`. Without one, `--cardano-only` still checks the Cardano side.
- **Safety.** The script and every Diagnose step are read-only and sign nothing. Each Remediation submits a Cardano transaction from the user's wallet, so the user runs it. Never ask for a seed or the project id. The script never prints the project id.

## Diagnose

1. **Which state is the registration in?**

   ```sh
   node check-dust-registration.mjs <stake1... or addr1q...> --dust <mn_dust1...>
   node check-dust-registration.mjs <stake_test1...> --network preprod --dust <mn_dust_preprod1...>
   ```

   It prints the live registrations on Cardano (`CARDANO`), the registrations made and removed recently (`HISTORY`), the cNIGHT the key holds (`NIGHT`) and what Midnight sees (`MIDNIGHT`). The last line is the verdict. Exit 0: registered once and generating; 2: a finding; 1: it could not run.
   - `WAIT FINDING: … expect it after <time>`: inside the normal wait. Tell the user not to register again: a second registration makes two, and then neither counts. Run it again after the time given.
   - `WAIT FINDING: registered, but all … arrived in the last … hours`: the same wait, for the cNIGHT. Run it again later.
   - `ESCALATE FINDING`: Stop and escalate.
   - `REGISTRATION FINDING: nothing is registered now. The last registration … was removed`: Diagnose 2.
   - `REGISTRATION FINDING: … only on <network>`: the key registered on another Cardano network. Remediation 1, on the right network.
   - `REGISTRATION FINDING: this stake key has no registration`: confirm this is the Cardano wallet that registered (the one connected to the DApp). If it is, Remediation 1.
   - `REGISTRATION FINDING: N live registrations`: the duplicates runbook.
   - `DUST ADDRESS FINDING`: Diagnose 3.
   - `NIGHT FINDING: … holds no cNIGHT`: Remediation 3.
   - `DUST ok`: both chains agree that DUST is generating. If the user still sees less or none, Diagnose 4. A `NIGHT note` line explains NIGHT that isn't counted yet.
   - `ADDRESS FINDING` or `DUST ADDRESS FINDING` about the input: the line says what is wrong with the address given.

2. **The DApp shows a registration that was removed.** The `HISTORY` lines give the time and the transaction that removed it. Ask whether the user pressed **STOP GENERATION** or used another tool. Then clear the page's stored data, as the duplicates runbook's "Re-registering from zero" section describes, reconnect, and check that the DApp no longer shows a registration. Then Remediation 1. Never register while the page still shows one.

3. **DUST goes to another DUST address.** The `DUST ADDRESS FINDING` line names the address the registration generates for. Nothing is lost: the DUST is in the wallet that owns that address. If the user wants it in the other wallet, Remediation 2.

4. **The chains say DUST is generating, but the wallet or the DApp shows less.** Check in this order:
   - Run step 1 with `--dust` set to the wallet's DUST address. A `DUST ADDRESS FINDING` means the wallet isn't the one receiving: Diagnose 3.
   - A `DAPP note` line means the DApp's Generation Rate and DUST Balance count only part of the NIGHT (Root cause 5). The `MIDNIGHT` line has the full figures. Connect the Midnight wallet to the DApp, or read the wallet itself.
   - The `MIDNIGHT … now X DUST` figure is generated DUST before fees. A wallet that has paid fees shows less.
   - Otherwise the wallet hasn't synced. For a wallet SDK app on Preprod, see the [Preprod wallet sync runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/wallet-preprod-sync-runbook/wallet-preprod-sync-runbook.md). Other wallets: **not tested**.

## Remediation

1. **Register once.** In the cNgD DApp for the network (Mainnet's is in the docs' [Mainnet environment](https://docs.midnight.network/guides/networks-and-environments)), connect the Cardano wallet that holds the cNIGHT and the Midnight wallet that should receive DUST, register once, and stop. Then run Diagnose 1: it should show one live registration and `WAIT` until the time it prints.

   *Trade-off:* no DUST until the wait passes, and a Cardano transaction fee.

2. **Point the registration at another DUST address.** With the registration showing in the DApp, use **CHANGE ADDRESS**, which replaces it in one transaction. If the DApp shows **NO REGISTRATION FOUND** while Diagnose 1 shows one live registration, don't register again: the DApp looks registrations up by DUST address ([midnight-cnight-to-dust-dapp#249](https://github.com/midnightntwrk/midnight-cnight-to-dust-dapp/issues/249)). Use the duplicates runbook's scripts to remove that registration and register once, run by the user.

   *Trade-off:* the new address waits as a new registration does before it generates (**inferred**).

3. **Bring the cNIGHT back under the registered key.** Move it to an address of the wallet that registered (the same stake key), or register the wallet that now holds it with Remediation 1.

   *Trade-off:* the moved cNIGHT waits before it counts (**inferred**).

## Confirm fixed

- Diagnose 1 with `--dust <the wallet's DUST address>` exits 0, and its last line is `DUST ok: registered once and generating DUST for` that address.
- The wallet with that DUST address shows a DUST balance that grows.

## Stop and escalate

Open an issue at the [servicedesk front door](https://github.com/midnightntwrk/servicedesk/issues/new/choose) when:

- The script prints an `ESCALATE FINDING`.
- A `NIGHT note` says Midnight counts less than the key has held for more than the wait, and it is still short a day later.
- `DUST ok` with the wallet's own `--dust`, the wallet fully synced, and its DUST still at zero a day later.
- The script exits 1 while Koios and the indexer answer for others.
- A source in Key identifiers disagrees with its row and no step covers that.

Include the network, the script's output, and the DApp's exact message. The script prints only public chain data, never the project id.

## Key identifiers

Each row names a public source and text it must contain: a repo file (`github:`), a published package file (`npm:`), or an issue's state (`issue:`). For your installed version, look under `node_modules/<package>/<path>`. If a source disagrees with a row, the source is right.

| Fact this runbook relies on | Source of truth | Must contain |
|---|---|---|
| Mainnet's mapping validator and cNIGHT token | `github:midnightntwrk/midnight-node/res/mainnet/cnight-config.json` | `"mapping_validator_address": "addr1w9e7ft4rrdd4rkdseguxr9hudfxyytm5ckh2qy0yhz7lfeg9lvhq7"` `"cnight_policy_id": "0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa"` `"cnight_asset_name": "NIGHT"` |
| Preprod's mapping validator and test cNIGHT | `github:midnightntwrk/midnight-node/res/preprod/cnight-config.json` | `"mapping_validator_address": "addr_test1wplxjzranravtp574s2wz00md7vz9rzpucu252je68u9a8qzjheng"` `"cnight_policy_id": "d2dbff622e509dda256fedbd31ef6e9fd98ed49ad91d5c0e07f68af1"` |
| Preview's | `github:midnightntwrk/midnight-node/res/preview/cnight-config.json` | `"mapping_validator_address": "addr_test1wplxjzranravtp574s2wz00md7vz9rzpucu252je68u9a8qzjheng"` `"cnight_policy_id": "d2dbff622e509dda256fedbd31ef6e9fd98ed49ad91d5c0e07f68af1"` |
| About 12 hours on Mainnet, the cNgD DApp, the Blockfrost endpoints and DUST address prefixes | `github:midnightntwrk/midnight-docs/docs/guides/networks-and-environments.mdx` | `reach a Midnight node, which takes about 12 hours` `https://midnight-dust-mainnet.nethermind.io/` `https://midnight-mainnet.blockfrost.io/api/v0?project_id=<token>` `https://midnight-preprod.blockfrost.io/api/v0?project_id=<token>` `mn_dust_preprod` `mn_dust_preview` |
| The DApp's wait per network and its syncing banner | `github:midnightntwrk/midnight-cnight-to-dust-dapp/src/components/dashboard/IndexerSyncBanner.tsx` | `isPreview ? '2.5 hours' : '12 hours'` `Registration Syncing` |
| The banner shows while the DApp holds a registration and the indexer says unregistered | `github:midnightntwrk/midnight-cnight-to-dust-dapp/src/components/dashboard/CardanoWalletCard.tsx` | `registrationUtxo && generationStatus?.registered === false` |
| The DApp's buttons, and its DUST Balance without a wallet | `github:midnightntwrk/midnight-cnight-to-dust-dapp/src/components/dashboard/MidnightWalletCard.tsx` | `'CHANGE ADDRESS'` `'STOP GENERATION'` `'NO REGISTRATION FOUND'` `specksToTDust(generationStatus.currentCapacity)` |
| The DApp's Generation Rate | `github:midnightntwrk/midnight-cnight-to-dust-dapp/src/components/dashboard/GenerationRateCard.tsx` | `BigInt(generationStatus.generationRate) * 3600n` |
| The DApp finds registrations by DUST address | `issue:midnightntwrk/midnight-cnight-to-dust-dapp#249` | `open` |
| The indexer's queries and the fields the script reads | `github:midnightntwrk/midnight-indexer/indexer-api/graphql/schema-v4.graphql` | `dustGenerationStatus(cardanoRewardAddresses: [CardanoRewardAddress!]!)` `dustGenerations(cardanoRewardAddresses: [CardanoRewardAddress!]!)` `registered: Boolean!` `valid: Boolean!` `utxoTxHash: HexEncoded` |
| `dustGenerationStatus` reads the newest generating UTXO | `github:midnightntwrk/midnight-indexer/indexer-api/src/infra/storage/dust.rs` | `ORDER BY ctime DESC` |
| `dustGenerations` adds up every generating UTXO | `github:midnightntwrk/midnight-indexer/indexer-api/src/infra/storage/dust_generations.rs` | `night_balance = night_balance.saturating_add(value);` |
| One live registration per stake key, or none counts | `github:midnightntwrk/servicedesk/runbooks/cnight-dust-duplicate-registration-runbook/cnight-dust-duplicate-registration-runbook.md` | `live registration UTXO at the mapping validator` |

## Reference material

- **Worked case:** [midnight-cnight-to-dust-dapp#231](https://github.com/midnightntwrk/midnight-cnight-to-dust-dapp/issues/231), `Registration Syncing` for weeks after a registration that had been removed twice.
- **Measurements:** the registration ages against Midnight's view, in this runbook's pull request.
- **Script:** [scripts/check-dust-registration.mjs](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/cnight-dust-after-registration-runbook/scripts/check-dust-registration.mjs), read-only: Koios for Cardano, the network's Midnight indexer for Midnight. [scripts/test-check-dust-registration.mjs](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/cnight-dust-after-registration-runbook/scripts/test-check-dust-registration.mjs) tests its address check and every verdict offline, on answers recorded on all three networks.
