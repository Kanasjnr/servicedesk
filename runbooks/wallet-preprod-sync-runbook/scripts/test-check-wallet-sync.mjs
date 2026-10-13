#!/usr/bin/env node
/**
 * test-check-wallet-sync.mjs: runs check-wallet-sync.mjs against a mock indexer on 127.0.0.1, so it
 * needs no network, no project id and no install (Node >= 22).
 *
 *   node test-check-wallet-sync.mjs
 *
 * The mock answers `{ block { height } }` over HTTP and the `dustLedgerEvents` / `zswapLedgerEvents`
 * subscriptions over graphql-transport-ws, with fixed newest ids. The state files are written to a
 * temporary directory in the shape wallet SDK 1.2.0's serializeState() writes, with dummy values.
 * Exit code 0 when every case passes.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const CHECKER = path.join(import.meta.dirname, 'check-wallet-sync.mjs');
const DUST_TIP = 50_000;
const ZSWAP_TIP = 60_000;

// ---------- mock indexer ----------
// HTTP: `mode` picks the answer. WebSocket: just enough of RFC 6455 and graphql-transport-ws.
let mode = 'ok';
let silentStream = false; // true: the delivery sample gets no events
const HTTP_ANSWERS = {
  ok: [200, { data: { block: { height: 123_456 } } }],
  mismatch: [403, { status_code: 403, error: 'Forbidden', message: 'Network token mismatch' }],
  missing: [403, { status_code: 403, error: 'Forbidden', message: 'Missing project token. Please include project_id in your request.' }],
  gone: [410, { message: 'This endpoint has been shut down.' }],
};

const frame = (text) => {
  const payload = Buffer.from(text);
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : null;
  if (!head) throw new Error('mock frames stay under 64 KB');
  return Buffer.concat([head, payload]);
};

// Client frames are masked; returns [opcode, text, bytes used] or undefined if incomplete.
const unframe = (buf) => {
  if (buf.length < 2) return undefined;
  let len = buf[1] & 0x7f;
  let at = 2;
  if (len === 126) {
    if (buf.length < 4) return undefined;
    len = buf.readUInt16BE(2);
    at = 4;
  } else if (len === 127) {
    if (buf.length < 10) return undefined;
    len = Number(buf.readBigUInt64BE(2));
    at = 10;
  }
  if (buf.length < at + 4 + len) return undefined;
  const mask = buf.subarray(at, at + 4);
  const data = Buffer.from(buf.subarray(at + 4, at + 4 + len));
  for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
  return [buf[0] & 0x0f, data.toString(), at + 4 + len];
};

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const [status, json] = HTTP_ANSWERS[mode];
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
  });
});

server.on('upgrade', (req, socket) => {
  const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: graphql-transport-ws\r\n\r\n`,
  );
  let buf = Buffer.alloc(0);
  let open = true;
  socket.on('error', () => {});
  socket.on('close', () => (open = false));
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (let f = unframe(buf); f; f = unframe(buf)) {
      const [opcode, text, used] = f;
      buf = buf.subarray(used);
      if (opcode === 8) {
        socket.end(Buffer.from([0x88, 0]));
        return;
      }
      if (opcode !== 1) continue;
      const msg = JSON.parse(text);
      if (msg.type === 'connection_init') socket.write(frame(JSON.stringify({ type: 'connection_ack' })));
      if (msg.type !== 'subscribe') continue;
      const field = /\{\s*(\w+)\s*\(/.exec(msg.payload.query)[1];
      const tip = field === 'dustLedgerEvents' ? DUST_TIP : ZSWAP_TIP;
      const event = (id) => frame(JSON.stringify({ id: msg.id, type: 'next', payload: { data: { [field]: { id, maxId: tip } } } }));
      if (msg.payload.query.includes('maxId')) socket.write(event(1));
      else if (!silentStream) {
        // The delivery sample: stream ids 1, 2, 3 … as fast as the socket takes them.
        let id = 1;
        const pump = () => {
          while (open && id <= tip) if (!socket.write(event(id++))) return socket.once('drain', pump);
        };
        pump();
      }
    }
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `127.0.0.1:${server.address().port}`;

// ---------- state files, in serializeState()'s shape ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-wallet-sync-'));
const hex = (bytes) => '00'.repeat(bytes);
const write = (name, value) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
};
const shielded = (offset, networkId = 'preprod') => ({
  publicKeys: { coinPublicKey: hex(32), encryptionPublicKey: hex(32) },
  state: hex(1900),
  protocolVersion: '0',
  offset: String(offset),
  networkId,
  coinHashes: {},
});
const dust = (offset, networkId = 'preprod', stateBytes = 190_000) => ({
  publicKey: { publicKey: hex(37) },
  state: hex(stateBytes),
  protocolVersion: '0',
  networkId,
  offset: String(offset),
});
const unshielded = (appliedId, networkId = 'preprod') => ({
  publicKey: { publicKey: hex(32), addressHex: hex(32), address: 'mn_addr_preprod1dummy' },
  state: { availableUtxos: [], pendingUtxos: [] },
  protocolVersion: '0',
  appliedId: String(appliedId),
  networkId,
});

// ---------- cases ----------
// The checker runs as a child process; execFile, not spawnSync, so the mock server keeps answering.
const run = ({ args, env = {} }) =>
  new Promise((resolve) =>
    execFile(process.execPath, [CHECKER, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 90_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout}${stderr}` }),
    ),
  );
const local = ['--indexer', `http://${base}/api/v0`, '--indexer-ws', `ws://${base}/api/v0/ws`];
// Each expectation is [regex over the output]; `code` is the exit code.
const CASES = [
  {
    name: 'healthy indexer, states of every kind',
    http: 'ok',
    args: [
      ...local,
      '--sample', '1',
      '--state', write('dust-behind.json', dust(40_000)),
      '--state', write('shielded-behind.json', shielded(59_000)),
      '--state', write('unshielded.json', unshielded(7)),
    ],
    code: 0,
    expect: [
      /^Indexer +http:\/\/127\.0\.0\.1:\d+\/api\/v0: block 123,456 +OK/m,
      /^DUST events +newest id 50,000 +INFO/m,
      /^Shielded events +newest id 60,000 +INFO/m,
      /^DUST delivery +[\d,]+ events\/s over 1 s +INFO +streaming all 50,000 events at this rate takes about \d+ min$/m,
      /^Fresh-wallet sync +50,000 DUST events to replay +INFO/m,
      /^State dust \(dust-behind\.json\) +offset 40,000, 10,000 events behind, 380 KB +OK +resumes from here; restoring it rebuilds/m,
      /^State shielded \(shielded-behind\.json\) +offset 59,000, 1,000 events behind, 4 KB +OK +resumes from here$/m,
      /^State unshielded \(unshielded\.json\) +appliedId 7, 1 KB +INFO/m,
      /^RESULT: nothing here stops a sync/m,
    ],
  },
  {
    name: 'states that will not resume',
    http: 'ok',
    args: [
      ...local,
      '--sample', '0',
      '--state', write('dust-zero.json', dust(0)),
      '--state', write('dust-past-tip.json', dust(DUST_TIP + 1)),
      '--state', write('shielded-past-tip.json', shielded(ZSWAP_TIP + 5)),
      '--state', write('big-dust.json', dust(49_000, 'preprod', 6_000_000)),
      '--state', write('not-json.json', 'not json'),
      '--state', write('other-shape.json', { hello: 'world' }),
      '--state', path.join(dir, 'missing.json'),
    ],
    code: 2,
    expect: [
      /^State dust \(dust-zero\.json\) +offset 0, 380 KB +WARN +saved before any event was applied/m,
      /^State dust \(dust-past-tip\.json\) +offset 50,001 is past this indexer's newest event 50,000 +FAIL +saved against a different indexer/m,
      /^State shielded \(shielded-past-tip\.json\) +offset 60,005 is past this indexer's newest event 60,000 +FAIL/m,
      /^State dust \(big-dust\.json\) +offset 49,000, 1,000 events behind, 12\.0 MB +OK/m,
      /^State \S+not-json\.json +.+ +FAIL +not a readable serializeState\(\) file/m,
      /^State \S+other-shape\.json +unrecognised shape +WARN/m,
      /^State \S+missing\.json +ENOENT.+ +FAIL/m,
      /^RESULT: at least one FAIL above/m,
    ],
    absent: [/DUST delivery/],
  },
  {
    name: 'a DUST stream that delivers nothing',
    http: 'ok',
    silent: true,
    args: [...local, '--sample', '1'],
    code: 0,
    expect: [/^DUST delivery +0 events\/s over 1 s +WARN +no event arrived in 1 s/m],
  },
  {
    name: 'project id for another network (403)',
    http: 'mismatch',
    args: [...local],
    code: 2,
    expect: [/^Indexer +.+HTTP 403 Network token mismatch +FAIL +the project id is for another network/m],
    absent: [/DUST events/],
  },
  {
    name: 'no project id reached the indexer (403)',
    http: 'missing',
    args: [...local],
    code: 2,
    expect: [/HTTP 403 Missing project token.+FAIL +no project id reached Blockfrost/],
  },
  {
    name: 'shut-down indexer (410)',
    http: 'gone',
    args: [...local],
    code: 2,
    expect: [/HTTP 410 .+FAIL +this indexer is shut down/],
  },
  {
    name: 'nothing listening',
    args: ['--indexer', 'http://127.0.0.1:9/api/v0', '--indexer-ws', 'ws://127.0.0.1:9/api/v0/ws'],
    code: 2,
    expect: [/^Indexer +http:\/\/127\.0\.0\.1:9\/api\/v0: .+ +FAIL +unreachable/m],
  },
  { name: 'preprod without a project id', args: ['--network', 'preprod'], env: { BLOCKFROST_PROJECT_ID: '' }, code: 1, expect: [/needs a project id\. Set BLOCKFROST_PROJECT_ID/] },
  { name: 'unknown network', args: ['--network', 'devnet'], code: 1, expect: [/--network must be preview, preprod or mainnet/] },
  { name: '--indexer without --indexer-ws', args: ['--indexer', `http://${base}/api/v0`], code: 1, expect: [/--indexer and --indexer-ws go together/] },
  { name: 'bad --sample', args: [...local, '--sample', 'soon'], code: 1, expect: [/--sample must be a number of seconds/] },
  { name: 'unknown argument', args: ['--states', 'x'], code: 1, expect: [/unknown argument --states/] },
];

let failed = 0;
for (const c of CASES) {
  mode = c.http ?? 'ok';
  silentStream = Boolean(c.silent);
  const { code, out } = await run(c);
  const problems = [];
  if (code !== c.code) problems.push(`exit ${code}, expected ${c.code}`);
  for (const re of c.expect) if (!re.test(out)) problems.push(`missing ${re}`);
  for (const re of c.absent ?? []) if (re.test(out)) problems.push(`unexpected ${re}`);
  if (problems.length) {
    failed++;
    console.log(`FAIL  ${c.name}\n      ${problems.join('\n      ')}\n${out.replace(/^/gm, '      | ')}`);
  } else console.log(`ok    ${c.name}`);
}


server.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} of ${CASES.length} cases failed` : `\nall ${CASES.length} cases passed`);
process.exit(failed ? 1 : 0);
