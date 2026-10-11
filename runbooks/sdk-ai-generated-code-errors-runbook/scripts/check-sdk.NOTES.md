# check-sdk.mjs: notes

How the SDK runbook's claims were reproduced, and how the checker was tested. Everything ran on
2026-10-10 and 2026-10-11 on macOS (x86_64) with Node 24.20.0, npm 11.19.0 and TypeScript 5.6.3.
Contracts were compiled with the `compact` CLI as `compact compile +0.31.1 --skip-zk`, which
leaves the default compiler alone. `test-check-sdk.mjs` re-runs all of it (see the end).

## The network set

Taken from the support matrix, `midnight-docs` `docs/relnotes/support-matrix.json` at `5263f40`
(2026-10-09). The pieces:

- compiler 0.31.1, `compact-runtime` 0.16.0 and `compact-js` 2.5.1;
- midnight-js 4.1.1 (it pins `ledger-v8` 8.1.0 and `onchain-runtime-v3` 3.0.0);
- the wallet SDK 1.2.0 umbrella (facade 4.1.0, dust-wallet 4.2.0, hd 3.0.3, shielded 3.0.2,
  unshielded 3.1.0);
- `dapp-connector-api` 4.0.1 and `testkit-js` 4.1.1.

It was installed in one project from `@midnight-ntwrk`. It needed an `overrides` entry for
`onchain-runtime-v3` 3.0.0, then `npm dedupe`. Without that, npm puts a second copy at the root (the
problem described in the proof-server runbook's NOTES).

## The corpus

Three Claude models wrote the code, run as Claude Code subagents: Haiku, Sonnet and Opus, on
2026-10-10. Each had no tools except Write. The prompt, in full apart from the output path:

> This is a recall test. Write TypeScript code for the Midnight blockchain from memory only, the
> way you would if a developer asked you in a chat with no tools. […] Don't hedge or leave TODOs;
> write complete, confident code with real-looking imports, as you'd hand it to a developer. […]
> Put the npm dependencies you'd install (name and version) in a comment block at the top of each
> file, like `// deps: @scope/pkg@1.2.3, other@4.5.6`. The DApp's Compact contract is already
> compiled to ./contract/out (it has a ledger `round: Counter` and a circuit `increment()`).
>
> - t01: Node.js script: create a wallet from a hex seed on Midnight preprod, wait until it is
>   synced, print its unshielded NIGHT balance and its DUST balance.
> - t02: Configure all the midnight-js providers needed to use the compiled contract from Node.js
>   (indexer/public data, proof server, ZK config, private state, wallet and midnight provider).
> - t03: Deploy the compiled contract on preprod and print its address.
> - t04: Find an already-deployed contract by address, call its increment circuit, then read and
>   print the ledger's round value.
> - t05: Subscribe to the contract's ledger state and log every change.
> - t06: Browser DApp (React is fine): connect to the Lace wallet through the Midnight DApp
>   connector, show the wallet address, and build providers that use the wallet for balancing,
>   submitting and proving.
> - t07: Register the wallet's NIGHT for DUST generation, then wait until DUST is available.
> - t08: Send 5 tNIGHT (unshielded) from the wallet to another Midnight address.
> - t09: A unit test (vitest) for the contract's increment circuit, without a network.
> - t10: Set the network to preprod and configure the indexer, node RPC and proof server endpoints.

Opus's first run stopped after t07 when the network dropped. t08 to t10 were written by a second
run on 2026-10-11 with the same prompt, plus one added line: "Each file must be self-contained (no imports from
local helper files other than the compiled contract)." The 30 files are in `cases/<model>/`
as the models wrote them, with two changes:
- **`t06.ts` became `t06.tsx`,** because it holds JSX.
- **The endpoints are Blockfrost's.** 18 files had the official preprod indexer and RPC hosts
  (`indexer.preprod.midnight.network/api/v1` or `/api/v3`, `rpc.preprod.midnight.network`).
  Those hosts were shut down in the move to Blockfrost, and the indexer answers HTTP 410. The 51
  URLs now point at Blockfrost's preprod endpoints, with the `project_id` the indexer runbook
  describes:
  - `https://midnight-preprod.blockfrost.io/api/v0` and its `/ws`;
  - `https://` and `wss://rpc.midnight-preprod.blockfrost.io`;
  - in the Node files, `?project_id=${process.env.BLOCKFROST_PROJECT_ID}`; in the browser file,
    `?project_id=<your preprod project_id>`.

  Each URL stayed on its line, and no recorded result changed.

The contract is `cases/contract/counter.compact`. For type checking, each model directory got a
`contract -> ../contract` link, because the models wrote both `./contract/out/…` and
`../contract/out/…`.

## What the models pinned

Every file has a `// deps:` line. Against the network set:

| Package | Haiku | Sonnet | Opus | Network set |
|---|---|---|---|---|
| midnight-js (every `midnight-js-*` package) | 3.0.0 (36 pins) | 3.0.0 (24) | 3.0.0 (40) | 4.1.1 |
| `compact-runtime` | 0.9.0 (6) | 0.9.0 (5) | 0.11.0 (5, never published), 0.9.0 (1) | 0.16.0 |
| `compact-js` | 2.0.0 (2, never published) | 2.0.0 (2, never published) | 2.3.0 (4) | 2.5.1 |
| Ledger | `ledger` 4.0.0 (5), `zswap` 4.0.0 (3) | `ledger-v7` 7.0.0 (5) | `ledger-v7` 7.0.0 (6), `ledger-v6` 6.1.0 (1, never published) | `ledger-v8` 8.1.0, via `midnight-js-protocol` |
| Wallet | `wallet` 4.0.0 (7), the pre-SDK API; `wallet-sdk-address-format` 1.0.0 (2) | `wallet-sdk-*` 1.0.0 | `wallet-sdk-*` 1.0.0, `wallet-sdk-hd` 3.0.0 | `wallet-sdk` 1.2.0 |
| `dapp-connector-api` | 3.0.0 | 4.0.0 | 4.0.0 | 4.0.1 |

All 100 midnight-js pins are 3.0.0, the January 2026 release (3.1.0 and 3.2.0 followed before
4.0). Its API, and the wallet SDK 1.0 of the same months, is what the models wrote against.

Two installs show what the pins do on their own:

- **Haiku t03's nine pins** install cleanly (95 packages, exit 0). The contract compiled with
  0.31.1 then fails on import: `TypeError: __compactRuntime.checkRuntimeVersion is not a function`.
  `compact-runtime` 0.9.0 predates the version check that compiled contracts call.
- **Sonnet t03's pins** fail at install with `npm error notarget No matching version found for
  @midnight-ntwrk/compact-js@2.0.0.`

What the compiler writes, for the same contract:

| Compiler | Output | `checkRuntimeVersion(…)` |
|---|---|---|
| 0.28.0, 0.29.0 | `contract/index.js`, `index.d.ts`, `index.js.map` | `'0.14.0'` |
| 0.31.1 | the same | `'0.16.0'` |
| 0.35.0 | the same | `'0.20.0'` |

None of them writes `index.cjs`, which four of Sonnet's files import.

## Type errors against the network set

Each file was compiled on its own, because the browser files' global declarations leak into each
other otherwise. The tsconfig:

```json
{ "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext", "jsx": "react-jsx",
  "strict": false, "noImplicitAny": false, "skipLibCheck": true, "esModuleInterop": true,
  "noEmit": true, "types": ["node"] }
```

Strictness is off so that only API errors count. The three browser files (`t06.tsx`) were also
compiled with `"moduleResolution": "bundler"` and the DOM lib, the way Vite resolves them; see the
connector section for why.

Results:
- **NodeNext:** 123 errors in 27 of 30 files. Only `haiku/t10.ts`, `sonnet/t10.ts` and `opus/t09.ts`
  compile.
- **Bundler, browser files only:** 15 errors. Three of them NodeNext doesn't show.

Not every error is an SDK mistake. Of the 126 distinct errors:
- **43 are cascades on `unknown`.** Once `@midnight-ntwrk/wallet` or another package fails to
  resolve, every property access on its values errors.
- **6 are the ESM extension rule** (TS2834, TS2835) on the models' own relative imports.
- **5 are imports of helper files the models assumed existed:** `./providers.js`, `./types.js`
  and similar.
- **2 are TS2769 overload cascades.**

That leaves 70 SDK errors. Each one is a name, package, version or call shape that the network
set doesn't have:

| Mistake | tsc | Files (Haiku / Sonnet / Opus) |
|---|---|---|
| `@midnight-ntwrk/wallet` and `WalletBuilder` (the pre-SDK wallet) | TS2307 | 4 / – / – |
| `ledger-v7`, `ledger-v6` | TS2307 | – / 4 / 7 |
| `contract/index.cjs` | TS2307 | – / 4 / – |
| `InMemoryTransactionHistoryStorage` from `wallet-sdk-unshielded-wallet` | TS2305 | – / 1 / 6 |
| `new WalletFacade(…)` | TS2673 | – / – / 6 |
| `walletBalance` on the DUST state | TS2339 | – / 1 / 1 |
| `ImpureCircuitId` | TS2305 | – / – / 4 |
| `FinalizedTransaction`, `UnprovenTransaction` from `midnight-js-types` | TS2459, TS2724 | – / – / 4 |
| `ContractAddress` from `midnight-js-types` | TS2724 | – / – / 2 |
| `MidnightProviders` from `midnight-js-contracts` | TS2459 | 1 / – / – |
| `createProviders` (invented) | TS2724 | 1 / – / – |
| `constructorContext`, `sampleCoinPublicKey` from `compact-runtime` | TS2724 | – / 1 / – |
| `currentQueryContext.state.data` | TS2339 | 1 / – / – |
| `DAppConnectorAPI`, `DAppConnectorWalletAPI`, `.enable()` | TS2305, TS2339 (bundler) | 1 / – / – |
| Own `Window.midnight` declaration with another type | TS2717 (bundler) | 1 / 1 / – |
| `ProofProvider<…>` | TS2315 | – / – / 2 |
| `async getCoinPublicKey()` | TS2322 | 1 / – / – |
| `levelPrivateStateProvider` with `walletProvider`, or without its two required fields | TS2353, TS2345 | 1 / 2 / 5 |
| Wallet configuration objects missing fields | TS2345 | – / – / 1 |

The same mistakes repeat across tasks. Opus, for example, wrote `new WalletFacade(…)` with
history storage from the wrong package in all six of its wallet files.

### dapp-connector-api 4.0.1 under NodeNext

`dist/index.d.ts` re-exports `./api`, `./errors` and `./globals` without file extensions, and the
package is `"type": "module"`. TypeScript's NodeNext resolution doesn't load extensionless
relative paths there. `--traceResolution` shows `Module name './api' was not resolved.` and the
same for `./globals`. The effect, on this test file:

```ts
import type { ConnectedAPI, InitialAPI } from '@midnight-ntwrk/dapp-connector-api';
export const c: ConnectedAPI = 42;
export const i: InitialAPI = 'not a wallet';
export const n: number = (null as unknown as ConnectedAPI).noSuchMethod();
```

| Resolution | `skipLibCheck` | tsc |
|---|---|---|
| NodeNext | true | no errors: every connector type is `any` |
| NodeNext | false | three TS2834 errors inside the package's `index.d.ts` |
| bundler | true or false | the three expected errors (TS2322, TS2322, TS2339) |

`window.midnight` is also undeclared under NodeNext (TS2339). The corpus's NodeNext pass therefore
didn't check the browser files' wallet calls. Its bundler pass did, and it found Haiku's
`.enable()` and the two conflicting `Window` declarations. 3.0.0 has the same extensionless
re-exports. That's why the index lists no exports for it, and the checker's renames table covers
its names instead.

## Checking the fixes

`cases/right-forms.ts` holds the form the checker recommends for each mistake: imports from
where the names live now, `WalletFacade.init` with wallet factories,
`InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries)`,
`state.dust.balance(new Date())`, the two `levelPrivateStateProvider` fields, synchronous key
getters, a non-generic `ProofProvider`, `InitialAPI.connect('preprod')`, and a contract test with
`createConstructorContext` and `createCircuitContext`.

- **tsc, bundler resolution:** 0 errors.
- **tsc, NodeNext:** one error, the `window.midnight` TS2339 above.
- **Run with tsx:** the contract-test part increments twice and reads the ledger from the
  `ChargedState`, printing `round after 1: 1n | after 2: 2n`.

Other facts the checker's messages rely on, each checked directly:

- **`new InMemoryTransactionHistoryStorage()`** with no arguments fails with `TS2554: Expected 1-2
  arguments, but got 0.`
- **`ChargedState`** in `onchain-runtime-v3` 3.0.0 has `state` and `toString`, and no `data`.
- **`UnprovenTransaction`:** `midnight-js-types` 0.2.5, 1.0.0 and 2.1.0 re-export it from
  `@midnight-ntwrk/ledger`. 3.2.0 and 4.1.1 only import it.
- **`DAppConnectorAPI` and `DAppConnectorWalletAPI`** (with `enable()`) are in `dapp-connector-api`
  1.2.3, 2.0.0 and 3.0.0. Their `window.midnight` is `{ [key: string]: DAppConnectorAPI }`.
  4.0.1 has `InitialAPI` and `ConnectedAPI` (`getShieldedAddresses()` and the rest).
- **`WalletProvider.getCoinPublicKey()` and `getEncryptionPublicKey()`** return plain values in
  midnight-js 3.0.0 and 4.1.1.
- **`engines`:** none of `midnight-js-contracts`, `midnight-js-types`, `wallet-sdk`,
  `wallet-sdk-facade`, `compact-runtime`, `ledger-v8` or `dapp-connector-api` declares it.
- **`@openzeppelin/compact-simulator`:** 0.3.1 depends on `compact-runtime` 0.16.0, and 0.4.1 on
  0.19.0. `@openzeppelin-compact/contracts-simulator` is a 404.
- **npm and the `latest` tag:**
  - `@midnight-ntwrk/wallet-sdk`'s `latest` tag is 1.1.0 although 1.2.0 is published
    ([midnight-wallet#791](https://github.com/midnightntwrk/midnight-wallet/issues/791)).
    `"^1.0.0"` therefore installs 1.1.0 (checked with `npm install --package-lock-only`).
  - The same lag holds for `wallet-sdk-hd` (`latest` 3.0.2, the set has 3.0.3) and
    `wallet-sdk-facade` (`latest` 4.0.1, the set has 4.1.0).
  - The `@midnightntwrk` scope's `latest` is current, but only the wallet SDK packages and a
    few others are published there.
- **Names that 404 in both scopes** (checked 2026-10-11): `compact`, `compact-compiler`,
  `compactc`, `zkir`, `midnight-sdk`, `midnight-js-wallet`.
  - `@midnightntwrk/midnight-js` is also a 404. `@midnight-ntwrk/midnight-js` is a real barrel
    package (4.0.3 to 4.1.1).
  - There is no `@midnight` scope.

## The checker

**The index.** `sdk-index.json` is built by `gen-sdk-index.mjs` from two installs:
- **current:** the network set;
- **legacy:** midnight-js 3.0.0, `compact-runtime` 0.9.0, `dapp-connector-api` 3.0.0,
  `wallet-sdk-*` 1.0.0, `ledger-v7` 7.0.3 and `wallet` 4.0.0, which brought `compact-js` 2.4.0
  and `onchain-runtime-v2` 2.0.1.

The 2026-10-11 index holds:
- 111 modules with 2 773 exports in the current set;
- 64 modules with 1 177 exports in the legacy set;
- the published versions and `latest` tag of 83 package names;
- 13 names confirmed missing.

**Coverage on the corpus.** Of the 70 SDK errors, the checker flags the line of 68. The two misses
are Opus t08's wallet configuration objects (TS2345). They need the configuration types, which
the checker doesn't model; tsc reports them.

The checker also flags 16 lines where tsc reports nothing, because an earlier error hides the
problem:
- 4 × `WalletBuilder.build…`, after the old wallet package failed to resolve;
- 7 × `new InMemoryTransactionHistoryStorage()` with no arguments, after the import failed;
- 5 × `levelPrivateStateProvider` without `accountId` or `privateStoragePasswordProvider`.

Each one is a real error once the earlier one is fixed. The TS2554 above confirms the history
storage case.

**False positives.** The checker was run on maintained code that targets the network set:

| Code | Files read | Findings |
|---|---|---|
| `midnight-examples` `95d4f50` (2026-10-09), `examples/` | 442 | 0 |
| the same, `templates/` | 67 | 0 |
| the same, `packages/` | 30 | 0 |
| `example-bboard` `f9df09a` (2026-10-09) | 59 | 0 |
| `midnight-local-dev` `902561d` | 16 | 0 |
| `example-counter` `273f083` (2026-08-14) | 29 | 7 |

The 7 example-counter findings are all real. Five are drift from the network set:
`compact-runtime` 0.15.0, and wallet-sdk sub-packages at `^2.0.0` and `^3.0.0`, which install
2.1.0 and 3.0.0. The other two are `InMemoryTransactionHistoryStorage` from
`wallet-sdk-unshielded-wallet` and its no-argument constructor. The repo's `wallet-sdk-shielded`
2.1.0 is the version in
[midnight-wallet#648](https://github.com/midnightntwrk/midnight-wallet/issues/648).

Two things had to be fixed in the checker to get this clean:
- **Workspace packages.** Names like `@midnight-ntwrk/example-fast-sync` are workspace members,
  not npm packages. The checker now reads `workspaces` and skips them.
- **Patch-level drift.** A range that installs `wallet-sdk-hd` 3.0.2 instead of 3.0.3 isn't
  reported; only major or minor drift is.

**`--explain`.** `cases/explain.json` holds 33 real error texts. Each comes from the corpus runs or
is quoted in the issue it names, and each has the substring the explanation must contain. One is
a Compact compiler error, which the checker must decline with exit 2.

## Re-running

`node test-check-sdk.mjs` takes about 10 s with no install. It checks three things: the flagged
lines for each corpus file against `cases/expected.json`, no findings on `right-forms.ts`, and the
33 explain cases.

`node test-check-sdk.mjs --tsc <dir>` also re-checks the ground truth. `<dir>` must have the
network set, `typescript` 5.6.3 and `@types/node` installed. The run takes about 2 minutes:
- it compiles the contract with 0.31.1;
- it runs tsc on every corpus file (NodeNext, and bundler for the browser files) and compares the
  138 errors with the recording;
- it typechecks `right-forms.ts` under bundler resolution.

When the network set moves, the order is:
1. Install the new set.
2. Re-run `gen-sdk-index.mjs`.
3. Run the test with `--tsc` against the new install.
4. Update the messages that name versions.
5. Re-record `expected.json` only for changes you have read.

**Not tested:**
- pnpm and Yarn PnP layouts;
- Windows;
- plain JavaScript projects (the checker reads them, but the corpus is TypeScript);
- tsconfig `extends` chains (the checker doesn't follow them);
- code from other assistants, or from models with documentation or MCP tools available. The
  corpus is three models recalling from memory, the worst case.
