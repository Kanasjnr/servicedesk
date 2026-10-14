#!/usr/bin/env node
/**
 * check-wallet-sync.mjs: read-only diagnostic for a wallet that syncs slowly, starts over on every
 * restart, or seems stuck. No wallet keys are needed and nothing is sent but indexer queries.
 *
 * It asks the indexer for the chain tip and for the newest DUST and shielded (zswap) ledger event,
 * which is how many events a fresh wallet has to replay. It times how fast the indexer streams
 * DUST events, which tells an indexer problem apart from a wallet that is slow to apply them. Given
 * the files a wallet saved with `serializeState()` or `state.serialize()`, it reads the position
 * each one was saved at and compares it with the indexer's newest event: how far behind it is, or
 * whether it was saved against a different indexer and will stall when restored.
 *
 * Requirements: Node >= 22 (it uses the built-in WebSocket). No npm install.
 *
 * Usage:
 *   node check-wallet-sync.mjs [--network preprod] [--state <file> ...] [--sample <seconds>]
 *                              [--indexer <http url> --indexer-ws <ws url>]
 *
 *   --network     preview | preprod | mainnet (default preprod). Preprod and mainnet go through
 *                 Blockfrost and read the project id from BLOCKFROST_PROJECT_ID; it is never printed.
 *   --state       a saved sub-wallet state file (shielded, unshielded or DUST). Repeat for each.
 *   --sample      seconds to time the DUST stream for (default 10, 0 to skip)
 *   --indexer, --indexer-ws
 *                 your own indexer instead (for example a local one), HTTP and WebSocket URLs of its
 *                 GraphQL API
 *
 * Status words: OK; FAIL (this will not sync like this); WARN (works, but costs time); INFO.
 * Exit code: 0 = no FAIL, 2 = at least one FAIL, 1 = could not run. 1 is never a verdict.
 */

import fs from 'node:fs';

const USAGE =
  'usage: node check-wallet-sync.mjs [--network <preview|preprod|mainnet>] [--state <file> ...] [--sample <seconds>] [--indexer <http url> --indexer-ws <ws url>]';
// Where each network's indexer is, at compile date (2026-10-13). Preprod and mainnet moved to
// Blockfrost on 2026-10-09; see the indexer migration runbook.
const ENDPOINTS = {
  preview: {
    http: 'https://indexer.preview.midnight.network/api/v4/graphql',
    ws: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
  },
  preprod: { http: 'https://midnight-preprod.blockfrost.io/api/v0', ws: 'wss://midnight-preprod.blockfrost.io/api/v0/ws', blockfrost: true },
  mainnet: { http: 'https://midnight-mainnet.blockfrost.io/api/v0', ws: 'wss://midnight-mainnet.blockfrost.io/api/v0/ws', blockfrost: true },
};
// DUST events a wallet applies per second on preprod, measured with wallet SDK 1.2.x (see the NOTES):
// moth-wallet 293/s, midnight-examples 338-378/s, both on desktop-class machines. Slower machines,
// or one busy with other work, apply fewer. The rate falls as the chain-wide DUST tree grows, so it
// does not carry over to other networks: preview's smaller tree applies far faster.
const APPLY_RATE = { low: 290, high: 380 };
// Measured fresh-wallet syncs for the networks where the preprod rate does not apply.
const MEASURED_FRESH = {
  preview: 'moth-wallet measured a fresh preview wallet at 103 s (August 2026)',
  mainnet: 'not measured; mainnet has the longest DUST history, so expect it to be the slowest',
};

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

// ---------- arguments ----------
const opts = { network: 'preprod', states: [], sample: 10, http: undefined, ws: undefined };
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? fail(`${a} needs a value\n${USAGE}`);
    if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (a === '--network') opts.network = next();
    else if (a === '--state') opts.states.push(next());
    else if (a === '--sample') opts.sample = Number(next());
    else if (a === '--indexer') opts.http = next();
    else if (a === '--indexer-ws') opts.ws = next();
    else fail(`unknown argument ${a}\n${USAGE}`);
  }
  if (!ENDPOINTS[opts.network]) fail(`--network must be preview, preprod or mainnet\n${USAGE}`);
  if (Boolean(opts.http) !== Boolean(opts.ws)) fail(`--indexer and --indexer-ws go together\n${USAGE}`);
  if (!Number.isFinite(opts.sample) || opts.sample < 0) fail(`--sample must be a number of seconds\n${USAGE}`);
}
if (typeof WebSocket !== 'function') fail(`This needs Node 22 or later (built-in WebSocket); this is Node ${process.versions.node}.`);

const endpoint = opts.http ? { http: opts.http, ws: opts.ws } : ENDPOINTS[opts.network];
const projectId = process.env.BLOCKFROST_PROJECT_ID?.trim();
if (endpoint.blockfrost && !projectId) {
  fail(
    `${opts.network} goes through Blockfrost, which needs a project id. Set BLOCKFROST_PROJECT_ID to a ` +
      `Midnight ${opts.network} project id (the token is per network) and run again. It is read from ` +
      'the environment and never printed.',
  );
}
const withKey = (u) => (endpoint.blockfrost ? `${u}?project_id=${encodeURIComponent(projectId)}` : u);
const redact = (s) => (projectId ? String(s).replaceAll(projectId, '<project_id>').replaceAll(encodeURIComponent(projectId), '<project_id>') : String(s));
const shown = (u) => u.replace(/\?.*$/, '');

// ---------- report ----------
const rows = [];
const add = (check, found, status, note = '') => rows.push({ check, found: redact(found), status, note: redact(note) });
const fmt = (n) => Number(n).toLocaleString('en-US');
const minutes = (events, rate) => Math.max(1, Math.round(events / rate / 60));

// ---------- indexer queries ----------
async function httpQuery(query) {
  const res = await fetch(withKey(endpoint.http), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body };
}

// Open a graphql-transport-ws subscription and hand each event to onEvent until it returns true or time runs out.
function subscribe(query, variables, onEvent, seconds) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(withKey(endpoint.ws), 'graphql-transport-ws');
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => finish(null, 'timeout'), seconds * 1000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init' }));
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.type === 'connection_ack') ws.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query, variables } }));
      else if (msg.type === 'next') {
        if (msg.payload?.errors) finish(new Error(JSON.stringify(msg.payload.errors).slice(0, 200)));
        else if (onEvent(Object.values(msg.payload.data)[0])) finish(null, 'done');
      } else if (msg.type === 'error') finish(new Error(JSON.stringify(msg.payload).slice(0, 200)));
    };
    ws.onerror = () => finish(new Error('the WebSocket connection failed'));
    ws.onclose = (e) => finish(e.code === 1000 ? null : new Error(`the WebSocket closed with code ${e.code}`), 'closed');
  });
}

async function newestEvent(field) {
  let found;
  const outcome = await subscribe(`subscription($id: Int) { ${field}(id: $id) { id maxId } }`, { id: 1 }, (e) => {
    found = e;
    return true;
  }, 60);
  if (!found) throw new Error(`no event within 60 s (${outcome})`);
  return BigInt(found.maxId);
}

// ---------- checks ----------
let tips = {};
{
  try {
    const { status, body } = await httpQuery('{ block { height } }');
    const height = body?.data?.block?.height;
    if (status === 200 && height !== undefined) add('Indexer', `${shown(endpoint.http)}: block ${fmt(height)}`, 'OK');
    else {
      const message = body?.message ?? body?.errors?.[0]?.message ?? body?.raw ?? JSON.stringify(body).slice(0, 160);
      const hint =
        status === 403 && /Missing project token/i.test(message)
          ? 'no project id reached Blockfrost'
          : status === 403 && /Network token mismatch/i.test(message)
            ? 'the project id is for another network: Blockfrost tokens are per network'
            : status === 403 && /Invalid project token/i.test(message)
              ? 'the project id is wrong'
            : status === 410
              ? 'this indexer is shut down; preprod and mainnet moved to Blockfrost (indexer migration runbook)'
              : '';
      add('Indexer', `${shown(endpoint.http)}: HTTP ${status} ${message}`, 'FAIL', hint);
    }
  } catch (e) {
    add('Indexer', `${shown(endpoint.http)}: ${e.message}`, 'FAIL', 'unreachable: check the URL and the network connection');
  }
}

if (!rows.some((r) => r.status === 'FAIL')) {
  for (const [name, field] of [
    ['DUST events', 'dustLedgerEvents'],
    ['Shielded events', 'zswapLedgerEvents'],
  ]) {
    try {
      tips[field] = await newestEvent(field);
      add(name, `newest id ${fmt(tips[field])}`, 'INFO', name === 'DUST events' ? 'a fresh wallet replays all of these, from every owner' : '');
    } catch (e) {
      add(name, e.message, 'FAIL', 'the WebSocket API did not answer');
    }
  }
}

if (tips.dustLedgerEvents !== undefined && opts.sample > 0) {
  let n = 0;
  const t0 = Date.now();
  try {
    await subscribe('subscription($id: Int) { dustLedgerEvents(id: $id) { id } }', { id: 1 }, () => {
      n++;
      return false;
    }, opts.sample);
    const rate = Math.round(n / ((Date.now() - t0) / 1000));
    const found = `${fmt(rate)} events/s over ${opts.sample} s`;
    if (n === 0) add('DUST delivery', found, 'WARN', `no event arrived in ${opts.sample} s: the indexer or the connection is the bottleneck`);
    else if (opts.network === 'preprod' && !opts.http) {
      // The apply rate was measured on preprod only; elsewhere the comparison would mislead.
      add(
        'DUST delivery',
        found,
        rate >= APPLY_RATE.high ? 'OK' : 'WARN',
        rate >= APPLY_RATE.high
          ? 'faster than a wallet applies them: a slow sync here is the wallet, not the indexer'
          : 'slower than a wallet can apply them: the indexer or the connection is the bottleneck',
      );
    } else {
      add('DUST delivery', found, 'INFO', `streaming all ${fmt(tips.dustLedgerEvents)} events at this rate takes about ${minutes(Number(tips.dustLedgerEvents), rate)} min`);
    }
  } catch (e) {
    add('DUST delivery', e.message, 'WARN', 'could not time the stream');
  }
}

if (tips.dustLedgerEvents !== undefined) {
  const events = Number(tips.dustLedgerEvents);
  const snapshot = 'A brand-new wallet can start from a pre-built snapshot instead (runbook, Remediation 3)';
  if (opts.network === 'preprod' && !opts.http) {
    add(
      'Fresh-wallet sync',
      `about ${minutes(events, APPLY_RATE.high)}-${minutes(events, APPLY_RATE.low)} min of DUST replay`,
      'INFO',
      `at the ${APPLY_RATE.low}-${APPLY_RATE.high} events/s measured on fast machines; slower or busy machines take longer. ${snapshot}`,
    );
  } else {
    add('Fresh-wallet sync', `${fmt(events)} DUST events to replay`, 'INFO', `${MEASURED_FRESH[opts.network] ?? 'not measured'}. ${snapshot}`);
  }
}

// Saved state files: JSON written by serializeState(). Shielded and DUST record `offset` (their
// appliedIndex); unshielded records `appliedId`. BigInts are written as strings.
for (const file of opts.states) {
  let snap;
  let bytes;
  try {
    const text = fs.readFileSync(file, 'utf8');
    bytes = Buffer.byteLength(text);
    snap = JSON.parse(text);
  } catch (e) {
    add(`State ${file}`, e.message, 'FAIL', 'not a readable serializeState() file');
    continue;
  }
  const kind = snap.publicKeys ? 'shielded' : 'appliedId' in snap || snap.state?.availableUtxos ? 'unshielded' : snap.publicKey ? 'dust' : undefined;
  if (!kind) {
    add(`State ${file}`, 'unrecognised shape', 'WARN', 'expected the JSON written by serializeState() in wallet SDK 1.2.0');
    continue;
  }
  const label = `State ${kind} (${file.split('/').pop()})`;
  const size = bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
  if (snap.networkId && snap.networkId !== opts.network && !opts.http) {
    add(label, `saved on ${snap.networkId}`, 'FAIL', `this check is for ${opts.network}; restore it only against ${snap.networkId}`);
    continue;
  }
  if (kind === 'unshielded') {
    add(label, `appliedId ${fmt(snap.appliedId ?? 0)}, ${size}`, 'INFO', 'resumes from this transaction id');
    continue;
  }
  const offset = BigInt(snap.offset ?? 0);
  const tip = tips[kind === 'dust' ? 'dustLedgerEvents' : 'zswapLedgerEvents'];
  const sizeNote = kind === 'dust' ? `; restoring it rebuilds a ${size} tree before syncing resumes (about 72 s for 11 MB on a fast machine, more as it grows)` : '';
  if (offset === 0n) {
    add(label, `offset 0, ${size}`, 'WARN', 'saved before any event was applied: restoring it is the same as a fresh sync (0 means "stream from the start")');
  } else if (tip === undefined) {
    add(label, `offset ${fmt(offset)}, ${size}`, 'INFO', `indexer tip unknown, so how far behind it is can't be told${sizeNote}`);
  } else if (offset > tip) {
    add(
      label,
      `offset ${fmt(offset)} is past this indexer's newest event ${fmt(tip)}`,
      'FAIL',
      'saved against a different indexer, whose event ids differ: restoring it stalls with "values inserted non-linearly". Discard it and sync from the start (cursor runbook)',
    );
  } else {
    const behind = Number(tip - offset);
    const eta = kind === 'dust' && opts.network === 'preprod' && !opts.http ? `, about ${minutes(behind, APPLY_RATE.high)}-${minutes(behind, APPLY_RATE.low)} min to catch up` : '';
    // Within range is only plausible: state saved against another indexer whose ids differ by a little (the official
    // preprod indexer and Blockfrost are 22 apart) passes too, and stalls on restore all the same.
    add(
      label,
      `offset ${fmt(offset)}, ${fmt(behind)} events behind, ${size}`,
      'OK',
      `plausible: within this indexer's range, but a state saved against another indexer can be too (runbook, Remediation 2)${eta}${sizeNote}`,
    );
  }
}

// ---------- print ----------
const widths = ['check', 'found', 'status'].map((k) => Math.max(k.length, ...rows.map((r) => r[k].length)));
const line = (r) => [r.check.padEnd(widths[0]), r.found.padEnd(widths[1]), r.status.padEnd(Math.max(6, widths[2])), r.note].join('  ').trimEnd();
console.log(line({ check: 'check', found: 'found', status: 'status', note: 'note' }));
for (const r of rows) console.log(line(r));
const failed = rows.some((r) => r.status === 'FAIL');
const warned = rows.some((r) => r.status === 'WARN');
console.log(
  `\nRESULT: ${
    failed
      ? 'at least one FAIL above: fix it before waiting on a sync.'
      : warned
        ? 'nothing here stops a sync, but the WARN rows above will slow it or cost a full replay (runbook, Diagnose step 1). If it still looks stuck, log its progress with scripts/watch-sync.ts (Diagnose step 2).'
        : 'nothing here stops a sync. If it still looks stuck, log its progress with scripts/watch-sync.ts (runbook, Diagnose step 2).'
  }`,
);
process.exit(failed ? 2 : 0);
