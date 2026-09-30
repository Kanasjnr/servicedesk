# Runbook: Migrating a Midnight app from the official indexer/RPC to Blockfrost

Moving a preprod app off `indexer.preprod.midnight.network` / `rpc.preprod.midnight.network`
and onto Blockfrost is mostly a URL swap plus a `project_id` token. The one hard break:
**Blockfrost numbers ledger events differently from the official indexer**, so any wallet
sync cursor or fast-sync (preseed) bundle made against one indexer fails on the other. Use
this runbook to do the migration, recognise that failure, and pick a remediation.

_Compiled 2026-09-29 from a preprod migration of the `midnight-examples` hello-world suite
(`@midnight-ntwrk/wallet-sdk` 1.2.0, `@midnight-ntwrk/ledger-v8` 8.1.2, midnight-js 4.1.1).
Event ids, offsets and schema fields are point-in-time. Re-run the diagnostic before
asserting any of them. The Midnight ecosystem changes fast._

---

## Symptom

Three failures show up in migration order. The last one is the subtle one.

- **Every Blockfrost call returns 403.** Indexer HTTP, indexer WS and node RPC all answer
  `{"error":"Forbidden","message":"Missing project token. Please include project_id in your request.","status_code":403}`.
  With a wrong token: `"Invalid project token."`
- **Crash before anything runs** when a config leaves the node WebSocket URL as a
  placeholder (e.g. `nodeWS: 'none'`): the wallet builder calls `new URL(nodeWS)` for its
  relay and submission service and throws `TypeError: Invalid URL`. (Found by reading the
  code; the placeholder was fixed before it ran.)
- **Wallet sync never finishes after switching indexers.** The wallet restores, shielded
  and unshielded sync to complete, but dust sticks at the same `appliedIndex` and the SDK
  logs this on every retry:

  ```
  Wallet.Other: Error while applying sync update
  [cause]: Error: values inserted non-linearly into dust generation tree; expected to insert index 399177, but received 399179.
      at DustLocalState.replayEventsWithChanges (…/@midnight-ntwrk/ledger-v8/midnight_ledger_wasm_bg.js)
  ```

  Nothing moves forward. CPU and memory keep ticking up, which looks like progress, until the
  app's sync timeout fires. Seen when restoring a fast-sync/preseed bundle cut against the
  official indexer and then syncing it from Blockfrost. The same applies to any saved wallet
  state (`serializeState()` output) carried across indexers. The exact indices in the
  message vary with the cursor.

## Root cause

**Ledger event ids are the indexer's own numbering, not chain data, and the two preprod
indexers disagree.** Both serve byte-identical `dustLedgerEvents` / `zswapLedgerEvents`
payloads for the same chain (the block hash at height 2684544 matches:
`67b8fa44691e435ee2baf2b7d151e788b6bd6288ccaf937dadee7f640eaf1419`). But:

| Id range (official numbering) | Official indexer | Blockfrost |
|---|---|---|
| ≤ 989780 | contiguous | same ids, same payloads |
| 989781–989802 | no dust or zswap event uses these ids | numbers straight through |
| ≥ 989803 → tip | id N | **id N − 22**, same payload |

At compile time the offset was a constant −22 from 989781 to the tip (`maxId` 1575271
official vs 1575249 Blockfrost). The gap sits between blocks 1130986 (last id 989780) and
1130996 (first id 989803 official, 989781 Blockfrost); the blocks between carry no dust or
zswap events on either indexer, and every block hash matches. Why the official indexer skips
those 22 ids is unconfirmed; tracked in `midnightntwrk/servicedesk#216`.

Wallet sync resumes each ledger-event subscription from a stored event id
(`dustLedgerEvents(id: $id)`, `zswapLedgerEvents(id: $id)` in
`@midnight-ntwrk/wallet-sdk-indexer-client`). A cursor taken on the official indexer points
22 events further along on Blockfrost. The dust wallet then replays the wrong events into
its generation tree, `DustLocalState.replayEventsWithChanges` rejects the out-of-order
insert, and the sync layer retries the same batch forever. Shielded sync can reach
`isStrictlyComplete()` from the same shifted cursor for an empty wallet. That shows only
that no tree insert collided, not that the state is correct, so do not rely on it.

The other two symptoms are plain configuration: Blockfrost needs its project token on every
request, and the SDK needs a real `wss://` node URL.

## Key identifiers

- **Endpoints (preprod).** Verified with a real token on 2026-09-29.

  | Service | Official (old) | Blockfrost (new) |
  |---|---|---|
  | Indexer HTTP (GraphQL) | `https://indexer.preprod.midnight.network/api/v4/graphql` | `https://midnight-preprod.blockfrost.io/api/v0` (`/api/v4/graphql` on the same host also answers; `/api/v0/graphql` is 404) |
  | Indexer WS | `wss://indexer.preprod.midnight.network/api/v4/graphql/ws` | `wss://midnight-preprod.blockfrost.io/api/v0/ws` (`graphql-transport-ws`) |
  | Node RPC HTTP | `https://rpc.preprod.midnight.network` | `https://rpc.midnight-preprod.blockfrost.io` |
  | Node RPC WS | `wss://rpc.preprod.midnight.network` | `wss://rpc.midnight-preprod.blockfrost.io` (`/ws` also answers) |
  | Proof server | local `:6300` | unchanged, not a Blockfrost service |

- **Auth.** Blockfrost accepts the token as a `project_id` header **or** a
  `?project_id=<token>` query parameter; a path segment is not recognised. Use the query
  parameter. The SDK clients (`indexerPublicDataProvider`, the wallet SDK indexer client,
  polkadot `WsProvider`) take plain URLs with no header hook, and browser WebSockets cannot
  set headers.
- **CORS.** Blockfrost answers preflight with `access-control-allow-origin: *`,
  `access-control-allow-methods: GET,HEAD,POST`, and any header.
- **GraphQL schema.** Blockfrost has every official field plus extras. The one difference in
  a shared field: `Subscription.dustGenerations` is
  `(dustAddress: DustAddress!, startIndex: Int!, endIndex: Int!)` on the official indexer
  and `(dustAddress: DustAddress!, blockHash: HexEncoded!, dtimeCutoffHeight: Int!)` on
  Blockfrost. No `@midnight-ntwrk` package in the stack above references
  `dustGenerations`. Blockfrost-only additions include contract-event queries
  (`Query.contract`, `Query.contractEvents`, `Subscription.contractEvents`,
  `Block.contractZswapState`, typed shielded/unshielded mint/burn/spend/receive events),
  contract-maintenance types, and a bridge API (`bridgeEvents`, `bridgeBalance`,
  `bridgeDeposits`, `bridgePoolSummary`, …). Code built only on the official schema needs
  no change.
- **Divergence point.** Official ids 989781–989802; offset −22 thereafter (at compile date).
- **Error text.** `values inserted non-linearly into dust generation tree` (also seen as
  `… into zswap commitment tree` / `… into dust commitment tree` for other cursor/tree
  mismatches).

## Diagnose

A Blockfrost token is required: every Blockfrost endpoint rejects anonymous calls. Keep the
token in your environment, never on the command line or in a committed file.

1. **Endpoints and auth** (should print a height, then `"Midnight Preprod"`):

   ```sh
   export BLOCKFROST_PROJECT_ID=<your preprod project token>
   curl -s -X POST -H 'content-type: application/json' \
     -d '{"query":"query { block { height hash } }"}' \
     "https://midnight-preprod.blockfrost.io/api/v0?project_id=$BLOCKFROST_PROJECT_ID"
   curl -s -X POST -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"system_chain","params":[]}' \
     "https://rpc.midnight-preprod.blockfrost.io?project_id=$BLOCKFROST_PROJECT_ID"
   ```

2. **Is the stored cursor portable?** Run
   [`scripts/check-indexer-cursor.mjs`](scripts/check-indexer-cursor.mjs) (Node ≥ 22, no
   `npm install`, read-only). It probes the target endpoints, checks both indexers are on the
   same chain, then fetches the event at your cursor from both and compares payloads. When
   they differ, it finds the same payload on the target and reports the id offset.

   ```sh
   # A cursor you already have (e.g. the stuck appliedIndex from the sync log):
   node check-indexer-cursor.mjs --id 1557519
   # A fast-sync / preseed bundle's cursors, read from its manifest:
   node check-indexer-cursor.mjs --manifest preseed/preprod/manifest.json
   ```

   Output for a bundle cut against the official indexer, checked against Blockfrost:

   ```
   == 3. Cursor portability
     dust @ 1557519: NOT PORTABLE (A's first event is id 1557519, B's is id 1557519, payloads differ)
       same payload found on B at id 1557497: offset -22 (B id = A id - 22)
   ```

   Exit code `2` means not portable: the symptom above is this root cause. Exit `0`
   (`PORTABLE`) means the cursor is fine and the stall is something else. Exit `1` means the
   check itself failed; read its output. Defaults compare the official preprod indexer (A)
   to Blockfrost preprod (B); `--a-http --a-ws --b-http --b-ws --b-rpc` override them.

## Remediation

Most practical first. No funds are at risk in any of these: a stuck sync never submits
anything.

1. **Do the config migration properly.**
   - Swap all four URLs.
   - Append `?project_id=<token>` to each, read from an env var (e.g.
     `BLOCKFROST_PROJECT_ID` in a gitignored `.env.<network>`).
   - Leave no placeholder `nodeWS`.
   - Build the config when it's used, not at import time, and fail fast with a clear
     message when the token is missing.

   The shape used in `midnight-examples`:

   ```ts
   function withBlockfrostKey(url: string, projectId: string): string {
     return `${url}${url.includes('?') ? '&' : '?'}project_id=${encodeURIComponent(projectId)}`;
   }
   export function preprodConfig(): NetworkConfig {
     const projectId = process.env['BLOCKFROST_PROJECT_ID']?.trim();
     if (!projectId) throw new Error('BLOCKFROST_PROJECT_ID is not set.');
     return {
       networkId: 'preprod',
       indexer:   withBlockfrostKey('https://midnight-preprod.blockfrost.io/api/v0', projectId),
       indexerWS: withBlockfrostKey('wss://midnight-preprod.blockfrost.io/api/v0/ws', projectId),
       node:      withBlockfrostKey('https://rpc.midnight-preprod.blockfrost.io', projectId),
       nodeWS:    withBlockfrostKey('wss://rpc.midnight-preprod.blockfrost.io', projectId),
       proofServer: process.env['MIDNIGHT_PROOF_SERVER'] ?? 'http://127.0.0.1:6300',
     };
   }
   ```

   Move **every** consumer at once: app config, test harnesses, scaffold templates, and
   scripts that cut preseed bundles or mint wallets. A half-migrated repo mints cursors on
   one indexer and replays them on the other.

2. **Re-sync wallets from genesis on the new indexer.** Discard saved wallet state from the
   old indexer. Do **not** migrate `serializeState()` output. A fresh wallet created against
   the new indexer, or an existing seed restored with a full sync, is correct by
   construction. The cost is the full sync time (~78 min on preprod against the official
   indexer, dominated by dust; not yet timed on Blockfrost).

3. **Cut a fast-sync / preseed bundle against the target indexer.** A bundle's cursors are
   only valid on the indexer that produced them. Cut with the cutter pointed at Blockfrost
   and **from genesis** (in `midnight-examples`: `yarn preseed:cut --from-genesis`).
   Bootstrapping the cutter from an official-indexer bundle fails with the same error.
   Keep one bundle per indexer and record the indexer URL in the manifest. Wallet birthday
   rules still apply: re-cutting means re-minting and re-funding wallets whose birthday
   predates the new bundle.

4. **Pin cursor-bearing consumers to one indexer (interim).** If only part of the stack can
   move, keep wallet sync on the indexer its cursors came from. Reads keyed by contract
   address, block height or block hash, and tx submission over RPC, carry no ledger-event
   cursor and can use Blockfrost.

5. **Not recommended: shift cursors by the offset.** Subtracting 22 from every stored id
   lines them up today. But the offset comes from one indexer skipping ids, and any future
   skip on either side silently changes it. Treat cursors as bound to their indexer.

**Browser DApps.** With the connector API, endpoints come from the user's wallet
(`getConfiguration()` → `indexerUri`, `indexerWsUri`, `substrateNodeUri`), not from DApp
code. Whether Lace accepts a custom Blockfrost URL with a `project_id` query was not tested.
A token placed in browser-side URLs is visible to anyone who loads the page; use a
server-side proxy or a token scoped for public use.

## Reference material

- Worked case: preprod migration of `midnightntwrk/midnight-examples` hello-world
  (2026-09-29). Upstream tracking for the id gap: `midnightntwrk/servicedesk#216`. Relevant
  files in that repo:
  `examples/hello-world/src/config.ts` (the migrated config);
  `packages/fast-sync/src/fast-wallet.ts` (`new URL(env.nodeWS)` for relay and submission;
  seeds sub-wallets from a reference bundle); `packages/fast-sync/scripts/cut-preseed.ts`
  (`--from-genesis`); `FAST-SYNC.md` ("When a bundle goes bad").
- SDK: `@midnight-ntwrk/wallet-sdk-indexer-client` `DustLedgerEvents` / `ZswapLedgerEvents`
  subscriptions (`dustLedgerEvents(id: $id) { id raw maxId }`);
  `@midnight-ntwrk/wallet-sdk-dust-wallet` `dist/v1/Sync.js` (resume by `id`);
  `@midnight-ntwrk/ledger-v8` `DustLocalState.replayEventsWithChanges` (the throw site).
- Official endpoints: <https://docs.midnight.network/guides/networks-and-environments>.
- Open questions to settle before relying on this long-term:
  - Why the official preprod indexer skips ids 989781–989802, and whether more skips should
    be expected (indexer team; `servicedesk#216`).
  - Blockfrost request quotas for a full genesis sync (preprod event ids run to ~1.58M).
  - Lace support for custom Blockfrost endpoints.
