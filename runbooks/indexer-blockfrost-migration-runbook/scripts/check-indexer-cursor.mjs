#!/usr/bin/env node
/**
 * check-indexer-cursor.mjs
 * ----------------------------------------------------------------------------
 * Read-only diagnostic for moving a Midnight wallet (or a fast-sync / preseed
 * bundle) from one indexer to another, e.g. the official preprod indexer to
 * Blockfrost.
 *
 * It answers three questions:
 *   1. Do the target endpoints answer at all (auth, paths)?
 *   2. Are both indexers on the same chain (block hash at a height)?
 *   3. Is a stored event cursor portable? Wallet sync resumes each ledger-event
 *      subscription from a stored event id. Those ids are the indexer's own
 *      numbering, so the check fetches the event at the cursor from both
 *      indexers and compares it byte for byte. When they differ it searches the
 *      target's stream for the same payload and reports the id offset.
 *
 * It only reads: GraphQL queries and subscriptions, plus one JSON-RPC
 * `system_chain` call. No wallet, no seed, no transactions.
 *
 * Requirements: Node >= 22 (global fetch and WebSocket). No npm install.
 *
 * Usage:
 *   export BLOCKFROST_PROJECT_ID=<your preprod project token>   # never pass it as an argument
 *   node check-indexer-cursor.mjs --id 1557519               # a stored cursor (dust + zswap)
 *   node check-indexer-cursor.mjs --manifest preseed/preprod/manifest.json
 *   node check-indexer-cursor.mjs --id 1557519 --stream dust --height 2684544
 *
 * Defaults compare the official preprod indexer (A, "from") against Blockfrost
 * preprod (B, "to"). Override with --a-http --a-ws --b-http --b-ws --b-rpc.
 * The Blockfrost token is appended to B's URLs as ?project_id=... and is
 * redacted from all output.
 *
 * With --manifest it first prints the indexer host the bundle records, if any
 * (newer cutters write one), which needs no query to A.
 *
 * Exit code: 0 = every checked cursor is portable, 2 = at least one is not,
 * 1 = the check itself failed (endpoint down, bad arguments).
 */

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const KEY = process.env.BLOCKFROST_PROJECT_ID?.trim() ?? '';
const withKey = (url) =>
  KEY && url.includes('blockfrost.io') && !url.includes('project_id=')
    ? `${url}${url.includes('?') ? '&' : '?'}project_id=${encodeURIComponent(KEY)}`
    : url;
const redact = (s) => (KEY ? String(s).split(encodeURIComponent(KEY)).join('<key>').split(KEY).join('<key>') : String(s));
const log = (...a) => console.log(...a.map(redact));

const A = {
  name: 'A (from)',
  http: opt('a-http', 'https://indexer.preprod.midnight.network/api/v4/graphql'),
  ws: opt('a-ws', 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws'),
};
const B = {
  name: 'B (to)',
  http: withKey(opt('b-http', 'https://midnight-preprod.blockfrost.io/api/v0')),
  ws: withKey(opt('b-ws', 'wss://midnight-preprod.blockfrost.io/api/v0/ws')),
  rpc: withKey(opt('b-rpc', 'https://rpc.midnight-preprod.blockfrost.io')),
};

if ([B.http, B.ws, B.rpc].some((u) => u.includes('blockfrost.io')) && !KEY) {
  console.error('BLOCKFROST_PROJECT_ID is not set; Blockfrost answers 403 without it.');
  process.exit(1);
}

// Cursors to check: from --id, or from a fast-sync manifest's witnesses.
const STREAMS = { dust: 'dustLedgerEvents', zswap: 'zswapLedgerEvents' };
const wanted = opt('stream', 'both');
const cursors = [];
const manifestPath = opt('manifest');
let manifestIndexer;
if (manifestPath) {
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // Bundles cut by newer tooling record the indexer host that produced their
  // cursors. That answers "which indexer is this from?" without querying A.
  manifestIndexer = typeof m.indexer === 'string' ? m.indexer : undefined;
  for (const w of Object.values(m.witnesses ?? {})) {
    const key = Object.keys(STREAMS).find((k) => STREAMS[k] === w.stream);
    if (key && (wanted === 'both' || wanted === key)) cursors.push({ stream: key, id: w.id });
  }
  if (!cursors.length) {
    console.error(`No dust/zswap witnesses in ${manifestPath}.`);
    process.exit(1);
  }
} else if (opt('id')) {
  for (const key of wanted === 'both' ? ['dust', 'zswap'] : [wanted]) {
    if (!STREAMS[key]) {
      console.error(`--stream must be dust, zswap or both (got '${wanted}').`);
      process.exit(1);
    }
    cursors.push({ stream: key, id: Number(opt('id')) });
  }
}

async function gql(url, query) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  if (json.errors) throw new Error(JSON.stringify(json.errors).slice(0, 300));
  return json.data;
}

async function rpc(url, method) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text).result;
}

/**
 * Subscribe to a ledger-event stream from `id` and collect `n` events
 * (graphql-transport-ws). Resolves early on complete, error or timeout.
 */
function take(wsUrl, stream, id, n, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const events = [];
    const ws = new WebSocket(wsUrl, 'graphql-transport-ws');
    const finish = (err) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      err && !events.length ? reject(err) : resolve(events);
    };
    const timer = setTimeout(() => finish(new Error('timed out')), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init', payload: {} }));
    ws.onerror = () => finish(new Error('WebSocket error (check URL and token)'));
    ws.onmessage = (msg) => {
      const d = JSON.parse(msg.data);
      if (d.type === 'connection_ack') {
        ws.send(JSON.stringify({
          id: '1',
          type: 'subscribe',
          payload: {
            query: `subscription S($id: Int) { ${STREAMS[stream]}(id: $id) { id raw } }`,
            variables: { id },
          },
        }));
      } else if (d.type === 'next') {
        const e = d.payload?.data?.[STREAMS[stream]];
        if (!e) return finish(new Error(JSON.stringify(d.payload).slice(0, 300)));
        if (events.length < n) events.push(e);
        if (events.length >= n) finish();
      } else if (d.type === 'error' || d.type === 'complete') {
        finish(new Error(`${d.type}: ${JSON.stringify(d.payload ?? '').slice(0, 300)}`));
      }
    };
  });
}

let failed = false;
let notPortable = false;

if (manifestPath) {
  log('== 0. Manifest');
  log(manifestIndexer
    ? `  cut against indexer: ${manifestIndexer} (recorded in the manifest)`
    : '  no indexer recorded in the manifest; steps 2-3 need A reachable to tell where it came from');
}

// 1. Target endpoints answer.
log('== 1. Target endpoints');
try {
  const tipB = (await gql(B.http, 'query { block { height hash } }')).block;
  log(`  indexer HTTP  ok   tip ${tipB.height}`);
} catch (e) { failed = true; log(`  indexer HTTP  FAIL ${e.message}`); }
try {
  await take(B.ws, 'dust', 0, 1, 20_000);
  log('  indexer WS    ok   subscription streams');
} catch (e) { failed = true; log(`  indexer WS    FAIL ${e.message}`); }
try {
  log(`  node RPC      ok   system_chain = ${await rpc(B.rpc, 'system_chain')}`);
} catch (e) { failed = true; log(`  node RPC      FAIL ${e.message}`); }

// 2. Same chain.
log('== 2. Same chain');
try {
  const tipA = (await gql(A.http, 'query { block { height } }')).block.height;
  const height = Number(opt('height', tipA - 100));
  const q = `query { block(offset: { height: ${height} }) { hash } }`;
  const [ha, hb] = await Promise.all([gql(A.http, q), gql(B.http, q)]);
  const same = ha.block?.hash && ha.block.hash === hb.block?.hash;
  log(`  height ${height}: A ${ha.block?.hash} | B ${hb.block?.hash} -> ${same ? 'same chain' : 'DIFFERENT'}`);
  if (!same) failed = true;
} catch (e) {
  failed = true;
  log(`  FAIL ${e.message}`);
  if (/HTTP 5\d\d/.test(e.message)) {
    log('  A is unreachable, so cursors cannot be compared. Without A, check the manifest\'s');
    log('  recorded indexer (step 0) or compare its cursors with the indexers\' maxId (see the runbook).');
  }
}

// 3. Cursor portability.
log('== 3. Cursor portability');
if (!cursors.length) log('  skipped (pass --id <cursor> or --manifest <path>)');
// A subscription from an id past an indexer's newest event waits for new
// events instead of returning, so a timeout here means "nothing at or after
// this id yet", not a failure.
const takeOrEmpty = (wsUrl, stream, id, n, timeoutMs) =>
  take(wsUrl, stream, id, n, timeoutMs).catch((e) => {
    if (e.message === 'timed out') return [];
    throw e;
  });

for (const { stream, id } of cursors) {
  try {
    const [[ea], [eb]] = await Promise.all([
      takeOrEmpty(A.ws, stream, id, 1, 20_000),
      takeOrEmpty(B.ws, stream, id, 1, 20_000),
    ]);
    if (!ea) throw new Error(`A has no ${stream} event at or after id ${id}; is this cursor from A?`);
    if (eb && ea.id === eb.id && ea.raw === eb.raw) {
      log(`  ${stream} @ ${id}: PORTABLE (same event at id ${ea.id} on both)`);
      continue;
    }
    notPortable = true;
    // Look for A's event in B's stream, 200 ids either side.
    const window = await takeOrEmpty(B.ws, stream, Math.max(0, ea.id - 200), 400, 20_000);
    const match = window.find((e) => e.raw === ea.raw);
    log(eb
      ? `  ${stream} @ ${id}: NOT PORTABLE (A's first event is id ${ea.id}, B's is id ${eb.id}, payloads differ)`
      : `  ${stream} @ ${id}: NOT PORTABLE (A has id ${ea.id}; B has no event at or after it yet)`);
    log(match
      ? `    same payload found on B at id ${match.id}: offset ${match.id - ea.id} (B id = A id ${match.id - ea.id >= 0 ? '+' : '-'} ${Math.abs(match.id - ea.id)})`
      : '    payload not found on B within +/-200 ids; the streams diverge further or differ in content');
  } catch (e) { failed = true; log(`  ${stream} @ ${id}: FAIL ${e.message}`); }
}

process.exit(failed ? 1 : notPortable ? 2 : 0);
