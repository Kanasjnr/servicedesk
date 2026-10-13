# check-wallet-sync.mjs and watch-sync.ts: notes

How the wallet sync runbook's claims were measured and reproduced, and how both scripts were
tested. Everything ran on 2026-10-13 against Preprod through Blockfrost, on macOS 14.7 (Intel Core
i5-1038NG7, 8 threads, 16 GB) with Node 24.20.0. The checker was also run on Node 22.19.0 and
20.19.1.

The machine was shared with other work for most of the day: the load average ran 6 to 20, and up
to 660 during run 2. The wallet rates measured here (80 to 190 DUST events a second) are therefore
lower than moth-wallet's and midnight-examples' (290 to 380). The runbook's estimates use theirs and
quote ours only as what a busy laptop does.

## Setup

- **Packages:** wallet SDK 1.2.0 (`wallet-sdk-facade` 4.1.0, `wallet-sdk-dust-wallet` 4.2.0,
  `wallet-sdk-shielded` 3.0.2, `wallet-sdk-unshielded-wallet` 3.1.0, `wallet-sdk-abstractions` 2.1.0,
  `wallet-sdk-indexer-client` 1.2.3), `testkit-js` 4.1.1 (only `WalletSeeds`),
  `midnight-js-protocol` 4.1.1 (the ledger keys), `effect` 3.22.2, `graphql-ws` 6.3.0, `tsx` 4.23.1,
  TypeScript 5.6.3.
- **Endpoints:** Blockfrost's Preprod indexer (`https://midnight-preprod.blockfrost.io/api/v0` and
  `/ws`) and node RPC (`wss://rpc.midnight-preprod.blockfrost.io`), with one project id read from the
  environment. Every harness redacted it from all console output.
- **Wallets:** a new random seed for each fresh run, never funded. Nothing was signed, proved or
  submitted.
- **Harness** (not in this repo):
  - `measure-sync.mjs` builds the three sub-wallets (fresh, or restored from saved files), starts
    the facade, and every 30 s logs each sub-wallet's applied position, target, rate,
    `isConnected` and strict completeness, plus RSS and load. It saves each sub-wallet with
    `serializeState()` every 10 minutes.
  - `verify-restore.ts` restores from saved files, logs every WebSocket open, close (with its code)
    and subscribe (with its variables), and runs `watch-sync.ts`.
  - `restart-on-stall.ts` does the same, and on a watch-sync warning saves, stops, restores and
    starts the wallet again in the same process.
  - A shell script around each, which suspends the process with `kill -STOP` (standing in for a
    laptop's sleep), resumes it with `kill -CONT`, and counts its open TCP connections with `lsof`
    every minute.

## Indexer numbers (Preprod through Blockfrost)

| Measure | Result |
|---|---|
| Tip at 15:16 UTC (the checker run in the runbook) | block 2,964,458; newest DUST event id 1,651,770; newest shielded event id 1,651,768 |
| Id growth | DUST target 1,650,046 at 10:58 UTC, 1,651,983 at 15:49 UTC: 1,937 ids in 4 h 51 min, about 400 an hour |
| DUST delivery | 3,074 events/s over 90 s; 6,253/s over 10 s; 14,218/s over 10 s (the checker run) |
| Preview delivery, official indexer | 1,608/s in an earlier test; 527/s and 3,447/s over 5 s in two checker runs |

**How much of the id counter DUST events take.** DUST and shielded events share one id counter.
3,000 events from each stream at five starting ids:

| From id | DUST: ids spanned | DUST density | Shielded: ids spanned | Shielded density |
|---|---|---|---|---|
| 1 | 1–3,786 | 0.79 | 2–19,690 | 0.15 |
| 400,000 | 400,000–403,003 | 1.00 | 402,682–1,000,946 | 0.005 |
| 800,000 | 800,000–802,999 | 1.00 | 854,123–1,029,435 | 0.02 |
| 1,200,000 | 1,200,000–1,203,152 | 0.95 | 1,200,044–1,258,192 | 0.05 |
| 1,600,000 | 1,600,000–1,603,001 | 1.00 | 1,600,023–1,637,625 | 0.08 |

So a newest DUST id of 1.65 million is about 1.6 million DUST events, and `maxId` is the newest id
of that stream's kind (the two newest ids differ).

## Runs

**Run 2: a fresh sync, then the laptop slept.** Started 10:42:40 UTC with the load average between 6 and 664.
DUST applied 12 to 127 events a second; shielded reached its target (1,650,108) at about 10:58. The
laptop then slept from about 10:58 to 12:41 (the 30 s timer skipped 6,161 s). After waking, DUST
stayed at 45,693 of 1,650,046 and shielded at 1,650,108 until the run was stopped at 14:02, with
more sleeps in between (timer gaps of 839, 228, 1,032, 164 and 805 s). Shielded's target never
moved either, though the chain added about 1,300 ids in that time, so it had stopped too while
reporting itself strictly complete. `isConnected` stayed `true` for all three. The log had 36
`Wallet.Sync: [object ErrorEvent]` lines, 12 per sub-wallet, and no indexer connection was open.
The periodic saves kept working while stalled: shielded 4,104 bytes, unshielded 369, DUST 382,024,
with DUST's `serializeState()` taking 115 to 1,602 ms. Those files are the saved state the later
runs restore from.

**Pause 1: a fresh sync suspended for 10 minutes.** Started 14:04:04, suspended 14:06:54 to
14:16:54. After resuming, shielded and DUST moved for about 30 s and then stopped (shielded at
476,726 of 1,651,428, DUST at 12,538 of 1,651,429). Shielded's and DUST's retries failed at
14:17:31 and 14:17:32, then again 1, 2, 4, 8, 16, 32, 64, 128 and 256 s later (the last at
14:26:02 and 14:26:03), each failing within a second; unshielded's followed the same pattern from
14:18:08. 31 errors in all. One TCP
connection was open a minute after resuming and none from 14:18:54 until the run was stopped at
14:26:55. `isConnected` stayed `true`.

**Pause 2, phase 1: restored, suspended for 8 minutes, with the first watch-sync.** Restored from
run 2's files at 14:53:48 (`restore()` calls 624 ms; the first state already at DUST 45,693).
Blockfrost dropped the indexer sockets with code 1006 every minute or two, and each reconnected
within a second. DUST stopped at 57,212 at 14:55:18 while its socket stayed open. The process was
suspended 14:57:38 to 15:05:38. Two other sockets dropped as it resumed, but DUST's stayed open and
silent until Blockfrost dropped it at 15:07:42; DUST was moving again by 15:08:09 (61,438). From
15:09:39 to 15:11:16 it went quiet again at 72,757, with no pause, until that socket dropped too.
The first watch-sync warned at 15:05:39, but only because the suspension counted as stall time.
After that it missed DUST standing still, because shielded kept moving with new blocks and any
movement reset its one stall clock. That led to the per-sub-wallet rule and the wake-up check.

**Pause 2, phase 2: a new process from the same saved state.** Started 15:13:51: `restore()` calls
333 ms, init and start 68 ms, first state 91 ms later at DUST 45,693 and shielded 1,650,108. It
subscribed `dustLedgerEvents` from id 45,692 and `zswapLedgerEvents` from 1,650,107 (the saved
offset minus one). DUST's socket dropped at 15:15:11 (1006) and the wallet resubscribed from 56,692
within 2 s. DUST ran at 134 to 173 a second.

**Pause 3: restored, suspended, with the current watch-sync and a restart on warning.** Restored at
15:24:30 (449 ms), suspended at 15:26:14 and resumed at 15:40:34 (the laptop also slept for part of
it). watch-sync printed `this process was paused for 15 min (asleep?); watching again from here`
and no warning. All three sockets dropped with 1006 as it resumed, reconnected within 2 s, and DUST
ran on at 80 to 191 a second. During this fast stretch DUST's subscription closed cleanly (code
1000) every minute or two and reopened 10,177 to 10,680 ids further on: the indexer client's
backpressure (`Backpressure.js`, pause at 10,000 events in flight), not an error, and the SDK logs
nothing for it. The laptop then slept from 15:50 to 18:22. After it woke, every reconnect failed
with 1006 within 2 s, in pairs at 18:22:36, :40, :46, :54 and 18:23:10, and again at 18:40:41 and
18:41:46 after another sleep. No TCP connection was open. DUST worked through events it had
already received (110,484 to 114,446), slowing to 3 a second, so it never stood still long enough
for a warning, and the in-process restart never ran. The run was stopped at 18:42.

**Starts from saved state:** pause 2 phase 1, pause 2 phase 2 and pause 3 each started a new
process from run 2's files, and each was at DUST 45,693 within a second and synced on.

**Fast sync from midnight-examples' snapshot.** midnight-examples at `aa9a7e7` (its `preseed/` and
`FAST-SYNC.md` unchanged since the `2f4912f` the runbook pins), installed with
`yarn workspaces focus @midnight-ntwrk/example-fast-sync` and run as `yarn preseed:cut` with
`MIDNIGHT_NETWORK=preprod`. That script makes a new random seed, takes the chain tip as its
birthday (2,967,980), seeds it from the shipped snapshot (height 2,779,435, cut 2026-09-30 18:53
UTC, 13 days old) and syncs it until all three sub-wallets are strictly complete. The run was kept
awake with `caffeinate`, and the load average fell from 24 to 8 during it.

| Phase | Time |
|---|---|
| Start to seeded (snapshot loaded and restored) | 4 min 24 s (21:08:51 to 21:13:15 UTC) |
| Seeded to fully synced | 14 min 14 s (to 21:27:29) |
| **Total** | **18 min 38 s** |

DUST started at the snapshot's position, 1,576,656, and caught up to 1,654,056: 77,400 ids at about
91 a second on average. Shielded was complete by about 21:16. The log had three
`Wallet.Sync: [object ErrorEvent]` lines (21:22:13, 21:25:49, 21:27:25), each followed by more
progress, and no `values inserted non-linearly`. midnight-examples' own figures are 72 s to restore
and 53 s to catch up with a nearly fresh snapshot, 126 s in all.

The birthday guard was read, not run: `isSeedable()` (`packages/fast-sync/src/preseed.ts:111`)
refuses a missing birthday, and `resolve.ts:135` only enables fast sync when `_BIRTHDAY` is
recorded. `assembleWallet` (`fast-wallet.ts:142`) fills a missing birthday with the current tip,
as its doc comment says, so a caller that passes `fastSync` without one is treated as a wallet
created now.

## check-wallet-sync.mjs

Run live:

| Case | Result |
|---|---|
| Preprod, with run 2's three state files | the output in the runbook, exit 0 |
| Preview | OK rows; DUST delivery is INFO with the time to stream every event (see the fix below) |
| Preprod without `BLOCKFROST_PROJECT_ID` | the "needs a project id" message, exit 1 |
| A Preprod project id against mainnet | FAIL `HTTP 403 Network token mismatch`, with the per-network hint, exit 2 |
| A wrong project id | FAIL `HTTP 403 Invalid project token.`, exit 2 |
| The official Preprod indexer (`--indexer`) | FAIL `HTTP 410 indexer.preprod.midnight.network was decommissioned on 2026-10-09…`, with the shut-down hint, exit 2 |
| Run 2's state files with `--network preview` | FAIL `saved on preprod` for each, exit 2 |
| Node 20.19.1 | "This needs Node 22 or later", exit 1 |
| Node 22.19.0 and 24.20.0 | runs |

One bug was found and fixed this way. On Preview the DUST delivery row said 527 events/s was
"faster than a wallet applies them", using the 380 a second threshold measured on Preprod; a
Preview wallet applies far faster (moth-wallet synced one in 103 s). The comparison now runs only
on Preprod. Elsewhere the row is INFO and gives the time to stream every event at the measured rate.

[`test-check-wallet-sync.mjs`](test-check-wallet-sync.mjs) runs the checker against a mock
indexer on 127.0.0.1 (HTTP plus enough of WebSocket and graphql-transport-ws), with state files in
the shape `serializeState()` writes, filled with dummy values. 12 cases: every kind of state file,
offset 0 (WARN), offsets past the indexer's newest event (FAIL), a 12 MB DUST state, unreadable,
unrecognised and missing files, a stream that delivers nothing, the 403 and 410 hints, nothing
listening, a missing project id, and four kinds of bad arguments. All pass on Node 22.19.0 and 24.20.0. To check that the
tests can fail, seven changes were made to a copy of the checker. Six failed at least one case. The
seventh (dropping one of the two unshielded-file checks) passes by design, because the other check
still recognises the file; dropping both fails.

## watch-sync.ts

- **Types:** strict `tsc --noEmit` with TypeScript 5.6.3 and `skipLibCheck`, under both
  `--module NodeNext` and `--moduleResolution Bundler`, together with Remediation 2's save and
  restore snippet.
- **Live:** pause 2 (the first version, which led to the per-sub-wallet rule) and pause 3 (the
  current version, the wake-up line).
- **Tests:** [`test-watch-sync.mjs`](test-watch-sync.mjs) runs it against a fake wallet whose
  positions the test moves, with time scaled down (a 40 ms tick, a 200 ms threshold) and a blocked
  event loop standing in for a suspended process. 7 cases: DUST stuck while shielded moves, slow
  but moving, synced and idle, nothing received at all, suspended, still stuck after waking, and
  `stop()`. All pass on Node 22.19.0 and 24.20.0. Four changes to a copy were each caught: no
  wake-up check, warning on synced sub-wallets, one stall clock for all three (the first
  version's rule), and `stop()` leaving the timer running.
- **The warning line in the runbook** is the real function's output for DUST at 57,212 of
  1,651,660 with shielded moving, under a fake clock that advances 30 s a tick, so the default
  10 minutes applies unchanged.

## Not tested

- Restarting only the wallet inside a running process (`wallet.stop()`, then restore and start):
  pause 3 was set up for it, but no warning came before the run ended.
- Wallet SDK 2.x, mainnet, Linux, and an indexer other than Blockfrost for the quiet stream.
- A live 10-minute warning from the current watch-sync: the warning line comes from the fake clock
  above.
