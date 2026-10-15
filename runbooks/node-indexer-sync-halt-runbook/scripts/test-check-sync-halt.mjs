#!/usr/bin/env node
/**
 * test-check-sync-halt.mjs: offline test of check-sync-halt.mjs. A local mock serves a node RPC, a
 * GraphQL indexer, the GitHub API and Docker Hub, with the real block times recorded around the four
 * known halts (preview 112450, preprod 164460, mainnet 1788980 and 2998112) on 2026-10-15. Blocks in
 * between are interpolated. Each case runs the checker as a separate process and checks its exit code
 * and output.
 *
 * Node >= 20, no install, no network.
 *
 *   node test-check-sync-halt.mjs
 *
 * Exit code: 0 = every case passed, 2 = at least one failed, 1 = could not run.
 */
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (Number(process.versions.node.split('.')[0]) < 20) {
  console.error(`Node >= 20 is required (this is ${process.version})`);
  process.exit(1);
}

const CHECK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-sync-halt.mjs');
const TOKEN = 'bf-test-token-do-not-print';
const GH_TOKEN = 'gh-test-token-do-not-print';

// ---------- chains: real block times (ms) around each known halt, recorded 2026-10-15 ----------
const RECORDED = {
  mainnet: { tip: 3024169, blocks: { 1788977: 1784643540000, 1788978: 1784643546000, 1788979: 1784643552000, 1788980: 1784643558000, 1788981: 1784643564000, 1788982: 1784643570000, 1788983: 1784643576000, 2998109: 1791908880001, 2998110: 1791908886000, 2998111: 1791908892000, 2998112: 1791908898000, 2998113: 1791908904000, 2998114: 1791908910000, 2998115: 1791908916000 } },
  preprod: { tip: 2991542, blocks: { 164457: 1775081598001, 164458: 1775081604000, 164459: 1775081610000, 164460: 1775081616000, 164461: 1775081622000, 164462: 1775081628001, 164463: 1775081634001 } },
  preview: { tip: 1307825, blocks: { 112447: 1784890524000, 112448: 1784890530000, 112449: 1784890536000, 112450: 1784890542000, 112451: 1784890548000, 112452: 1784890554001, 112453: 1784890560000, 128536: 1784987070001, 128537: 1784987076000 } },
};
// First block of runtime 1.0.300 (spec 1000300) on each network; before it, Preprod ran 0.22 (22000)
// at the heights here and the others 1.0.0 (1000000).
const RUNTIME_SWITCH = { mainnet: 2738210, preprod: 2648468, preview: 1074620 };
const specAt = (network, h) => (h >= RUNTIME_SWITCH[network] ? 1000300 : network === 'preprod' ? 22000 : 1000000);
// The TTL or DUST time each known block's transaction holds, as the chain stores it (u32 little-endian).
const HOLDS = { mainnet: { 2998112: 1791908899, 1788980: 1784643562 }, preprod: { 164460: 1775081620 }, preview: { 112450: 1784890545, 128537: 1784987084 } };
const CHAIN_NAMES = { mainnet: 'Midnight Mainnet', preprod: 'Midnight Preprod', preview: 'Midnight Preview' };
// Transactions the mock indexer knows, as the public indexers return them.
const TXS = {
  preprod: { '6a1005eecf695a8f950e8f8e74de0c6336daf55448326bf0db0b3b55c089ad0b': 164460 },
  preview: { d3f88e6b08607a2d3e0179a07b92eded2518194de529fe2d3cf3e07fc52c96f2: 112450, '3864da188d7c1d85062c914f879e1e4c096d443abf139aa9717b5266945959e8': 128537 },
};

// Block time anywhere on a chain: recorded where known, otherwise interpolated between the recorded
// points (genesis at 6 s before the first one per block, the tip 6 s per block after the last).
function timeOf(network, h, tip) {
  const rec = RECORDED[network].blocks;
  if (rec[h] !== undefined) return rec[h];
  const hs = Object.keys(rec).map(Number).sort((a, b) => a - b);
  const points = [[0, rec[hs[0]] - hs[0] * 6000], ...hs.map((x) => [x, rec[x]]), [tip, rec[hs.at(-1)] + (tip - hs.at(-1)) * 6000]];
  for (let i = 1; i < points.length; i++) {
    const [h0, t0] = points[i - 1], [h1, t1] = points[i];
    if (h <= h1) return Math.round(t0 + ((t1 - t0) * (h - h0)) / (h1 - h0)) + 500; // +500 ms: off the whole-second marks
  }
  return undefined;
}
const hashOf = (network, h) => `0x${Buffer.from(`${network}:${h}`).toString('hex').padEnd(64, '0').slice(0, 64)}`;
const heightOfHash = (hash) => {
  const [network, h] = Buffer.from(hash.slice(2).replace(/(00)+$/, ''), 'hex').toString().split(':');
  return { network, h: Number(h) };
};

// ---------- the mock ----------
const calls = [];
let rateLimitGithub = false;
const tipOf = (name) => (name.startsWith('halted-') ? 1788979 : RECORDED[networkOf(name)].tip);
const networkOf = (name) => name.replace(/^(local|halted|flaky|dying)-/, '');
let flakyCount = 0;

function rpc(name, body) {
  const network = networkOf(name), tip = tipOf(name);
  const { method, params } = body;
  if (method === 'system_chain') return CHAIN_NAMES[network];
  if (method === 'chain_getHeader') return { number: `0x${tip.toString(16)}` };
  if (method === 'chain_getBlockHash') return params[0] >= 0 && params[0] <= tip ? hashOf(network, params[0]) : null;
  if (method === 'state_getRuntimeVersion') return { specName: 'midnight', specVersion: specAt(network, heightOfHash(params[0]).h) };
  if (method === 'chain_getBlock') {
    const { h } = heightOfHash(params[0]);
    const v = HOLDS[network][h];
    const body = Buffer.concat([Buffer.from('0123456789abcdef', 'hex'), ...(v ? [Buffer.from(Uint32Array.of(v).buffer)] : []), Buffer.from('fedcba98', 'hex')]);
    return { block: { header: { number: `0x${h.toString(16)}` }, extrinsics: ['0x0c040100', `0x${body.toString('hex')}`] } };
  }
  if (method === 'state_getStorage') {
    const { h } = heightOfHash(params[1]);
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(timeOf(network, h, tip)));
    return `0x${b.toString('hex')}`;
  }
  throw new Error(`no ${method}`);
}

function graphql(network, query) {
  const tip = RECORDED[network].tip;
  let m;
  if ((m = query.match(/transactions\(offset: \{ hash: "([0-9a-f]{64})" \}\)/))) {
    const h = TXS[network]?.[m[1]];
    return { transactions: h ? [{ block: { height: h, hash: hashOf(network, h).slice(2), timestamp: timeOf(network, h, tip) } }] : [] };
  }
  if ((m = query.match(/block\(offset: \{ height: (\d+) \}\)/))) {
    const h = Number(m[1]);
    return { block: h <= tip ? { hash: hashOf(network, h).slice(2), timestamp: timeOf(network, h, tip), protocolVersion: specAt(network, h) } : null };
  }
  if (/\{ block \{ height \} \}/.test(query)) return { block: { height: tip } };
  throw new Error(`unexpected query ${query}`);
}

const TAGS = {
  'midnightntwrk/midnight-indexer': ['v4.3.3', 'v4.3.4', 'v4.3.5', 'v4.3.7', 'v4.3.800-rc.1', 'v4.3.800-rc.2', 'v4.4.0-rc.5', 'v4.4.0-pre-alpha.16-l91r3-x'],
  'midnightntwrk/midnight-node': ['node-1.0.2', 'node-1.0.300', 'node-1.0.400', 'node-2.1.0-rc.3', 'node-2.1.0-rc.4'],
};
const FIXED = new Set(['v4.3.800-rc.2', 'node-1.0.400', 'node-2.1.0-rc.4']);
const FIX_TITLES = {
  'midnightntwrk/midnight-indexer': 'fix(chain-indexer): accept the first regular transaction at either tblock (#1610)',
  'midnightntwrk/midnight-node': "fix(ledger): retry tblock-corrected first tx at the block's own tblock",
};
const HUB = {
  'midnightntwrk/indexer-standalone': [['4.3.800-rc.2', 'sha256:fixed'], ['latest', 'sha256:old'], ['4.3.7', 'sha256:old'], ['4.3.7-amd64', 'sha256:old']],
  'midnightntwrk/chain-indexer': [['4.3.800-rc.2', 'sha256:fixed2'], ['latest', 'sha256:old2'], ['4.3.7', 'sha256:old2']],
  'midnightntwrk/midnight-node': [['latest-main', 'sha256:main'], ['1.0.400', 'sha256:n400'], ['1.0.300', 'sha256:n300'], ['2.1.0-rc.4', 'sha256:n21']],
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const [, kind, name] = url.pathname.split('/');
    calls.push({ kind, name, path: url.pathname, query: url.search, auth: req.headers.authorization });
    try {
      if (kind === 'rpc') {
        if (name === 'down') { res.destroy(); return; }
        const body = JSON.parse(raw);
        // flaky-: drops every other request; dying-: drops every block lookup.
        if (name.startsWith('flaky-') && flakyCount++ % 2 === 0) { res.destroy(); return; }
        if (name.startsWith('dying-') && body.method === 'chain_getBlockHash') { res.destroy(); return; }
        return send(200, { jsonrpc: '2.0', id: body.id, result: rpc(name, body) });
      }
      if (kind === 'indexer') {
        const network = name;
        if (['preprod', 'mainnet'].includes(network) && url.searchParams.get('project_id') !== TOKEN) return send(403, { error: 'Forbidden', message: 'Missing project token.' });
        return send(200, { data: graphql(network, JSON.parse(raw).query) });
      }
      if (kind === 'gh') {
        if (rateLimitGithub) return send(403, { message: 'API rate limit exceeded' });
        const m = url.pathname.match(/^\/gh\/repos\/([^/]+\/[^/]+)\/(tags|commits)$/);
        const repo = m[1];
        if (m[2] === 'tags') return send(200, url.searchParams.get('page') === '1' ? TAGS[repo].map((name) => ({ name })) : []);
        const tag = url.searchParams.get('sha');
        return send(200, [{ commit: { message: 'chore: bump' } }, ...(FIXED.has(tag) ? [{ commit: { message: `${FIX_TITLES[repo]}\n\nbody` } }] : [])]);
      }
      if (kind === 'hub') {
        const one = url.pathname.match(/^\/hub\/v2\/repositories\/([^/]+\/[^/]+)\/tags\/([^/]+)$/);
        if (one) { const hit = HUB[one[1]].find(([n]) => n === decodeURIComponent(one[2])); return hit ? send(200, { name: hit[0], digest: hit[1] }) : send(404, { message: 'not found' }); }
        const image = url.pathname.match(/^\/hub\/v2\/repositories\/([^/]+\/[^/]+)\/tags$/)[1];
        // Only the most recent tags, without `latest`: `latest` must be fetched by name.
        return send(200, { results: HUB[image].filter(([n]) => n !== 'latest').map(([n, digest]) => ({ name: n, digest })) });
      }
      send(404, {});
    } catch (e) { send(500, { message: e.message }); }
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const PUBLIC = JSON.stringify(Object.fromEntries(['mainnet', 'preprod', 'preview'].map((n) => [n, { indexer: `${BASE}/indexer/${n}`, rpc: `${BASE}/rpc/public-${n}` }])));

function run(args, { env = {}, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHECK, ...args], {
      env: {
        PATH: process.env.PATH,
        CHECK_SYNC_HALT_GITHUB_API: `${BASE}/gh`,
        CHECK_SYNC_HALT_DOCKER_HUB: `${BASE}/hub`,
        CHECK_SYNC_HALT_LOCAL_RPC: `${BASE}/rpc/down`,
        CHECK_SYNC_HALT_PUBLIC: PUBLIC,
        CHECK_SYNC_HALT_RETRY_MS: '10',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stdout, stderr, all: stdout + stderr }));
    child.stdin.end(input ?? '');
  });
}

// ---------- the halts, as reported ----------
const MAINNET_2998112 = 'index_blocks_task failed: apply transactions to ledger state: cannot apply regular transaction d9fd8f7fd5e1462f02bb862c437ad9b75e3f63ed55a3e84ec8d90fa2a44f3284: malformed transaction: transaction application error detected during verification: Intent TTL has expired. TTL: Timestamp(1791908899), Current block: Timestamp(1791908904)';
const NODE_2229 = 'Transaction malformed: transaction application error detected during verification: Intent TTL has expired. TTL: Timestamp(1784643562), Current block: Timestamp(1784643564)\nTransaction(3) failed due to Invalid(Custom(182)). Aborting the rest of the block execution.';
const PREPROD_1461 = '{"level":"ERROR","target":"indexer_standalone","message":"chain-indexer exited with ERROR","kvs":{"error":"index_blocks_task failed: apply transactions to ledger state: cannot apply regular transaction 6a1005eecf695a8f950e8f8e74de0c6336daf55448326bf0db0b3b55c089ad0b: malformed transaction: transaction application error detected during verification: Intent TTL has expired. TTL: Timestamp(1775081620), Current block: Timestamp(1775081622)"}}';
const PREVIEW_1365 = '{"level":"WARN","target":"midnight_ledger::dust","message":"dust actions out of TTL range ctime=Timestamp(1784890545) tblock=Timestamp(1784890542) grace_period=Duration(10800)"}\n{"level":"ERROR","message":"chain-indexer exited with ERROR","kvs":{"error":"index_blocks_task failed: apply transactions to ledger state: cannot apply regular transaction d3f88e6b08607a2d3e0179a07b92eded2518194de529fe2d3cf3e07fc52c96f2: malformed transaction: dust is outside of its validity window (declared time: Timestamp(1784890545), window: [Timestamp(1784879742), Timestamp(1784890542)])"}}';

const cases = [
  ['mainnet indexer 4.3.7 (2998112): pattern A by time, fix and releases named', async () => {
    const r = await run(['--network', 'mainnet', '--rpc', `${BASE}/rpc/mainnet`, '--error', MAINNET_2998112]);
    return [r.code === 0, /Block: 2998112 .*time 1791908898/.test(r.stdout), /checked it at parent \+ 12 s \(1791908904\)/.test(r.stdout),
      /valid at the block's own time: yes; valid at parent \+ 12 s: no/.test(r.stdout), /Known pattern A\..*Indexer v4\.3\.5 to v4\.3\.800-rc\.1/.test(r.stdout),
      /holds the transaction's TTL/.test(r.stdout), /runtime spec 1000300/.test(r.stdout), /will stop again on later blocks/.test(r.stdout),
      /midnight-indexer tags with the fix: v4\.3\.800-rc\.2\n/.test(r.stdout), /indexer-standalone: images with the fix: 4\.3\.800-rc\.2; `latest` is 4\.3\.7, without the fix/.test(r.stdout),
      !/Two blocks fit/.test(r.stdout), !/midnight-node tags/.test(r.stdout)];
  }],
  ['mainnet node 1.0.300 (1788980): pattern A, node fix and node releases', async () => {
    const r = await run(['--network', 'mainnet', '--rpc', `${BASE}/rpc/mainnet`, '--error', NODE_2229]);
    return [r.code === 0, /Halt: node on mainnet/.test(r.stdout), /Block: 1788980 /.test(r.stdout), /Node 1\.0\.300 \(and 2\.1\.0-rc\.3\) does that/.test(r.stdout),
      /runtime spec 1000000/.test(r.stdout), !/will stop again/.test(r.stdout),
      /midnight-node#2216/.test(r.stdout), /midnight-node tags with the fix: node-1\.0\.400, node-2\.1\.0-rc\.4/.test(r.stdout), /there is no `latest` tag/.test(r.stdout)];
  }],
  ['preprod indexer (164460): found by hash through the token-gated indexer, token never printed', async () => {
    const r = await run(['--network', 'preprod', '--error', PREPROD_1461], { env: { BLOCKFROST_PROJECT_ID: TOKEN, GITHUB_TOKEN: GH_TOKEN } });
    const used = calls.some((c) => c.kind === 'indexer' && c.query.includes(TOKEN));
    const ghAuth = calls.some((c) => c.kind === 'gh' && c.auth === `Bearer ${GH_TOKEN}`);
    return [r.code === 0, /Block: 164460 /.test(r.stdout), /found by the transaction hash, from the public preprod indexer/.test(r.stdout), /Known pattern A/.test(r.stdout),
      used, ghAuth, !r.all.includes(TOKEN), !r.all.includes(GH_TOKEN)];
  }],
  ['a token inside an --indexer or --rpc URL is never printed, even in "found by" and error lines', async () => {
    const r = await run(['--network', 'preprod', '--offline', '--indexer', `${BASE}/indexer/preprod?project_id=${TOKEN}`, '--rpc', `${BASE}/rpc/down?project_id=${TOKEN}`, '--error', PREPROD_1461], { env: { BLOCKFROST_PROJECT_ID: TOKEN } });
    const bad = await run(['--network', 'preprod', '--offline', '--indexer', `${BASE}/indexer/preprod?project_id=${TOKEN}`, '--error', PREPROD_1461.replace('6a1005ee', '00000000')], { env: { BLOCKFROST_PROJECT_ID: TOKEN, CHECK_SYNC_HALT_PUBLIC: JSON.stringify({ preprod: { indexer: `${BASE}/gone`, rpc: `${BASE}/rpc/down` } }) } });
    return [r.code === 0, /found by the transaction hash, from .*project_id=<token>/.test(r.stdout), !r.all.includes(TOKEN), !bad.all.includes(TOKEN)];
  }],
  ['preview indexer (112450, DUST window): pattern B, read from stdin', async () => {
    const r = await run(['--network', 'preview', '--offline'], { input: PREVIEW_1365 });
    return [r.code === 0, /"dust is outside of its validity window" \(DUST time 1784890545, checked at 1784890542\)/.test(r.stdout), /Block: 112450 /.test(r.stdout),
      /checked it at the block's own time \(1784890542\)/.test(r.stdout), /valid at the block's own time: no; valid at parent \+ 12 s: yes/.test(r.stdout), /Known pattern B\..*v4\.3\.3 and earlier/.test(r.stdout),
      !/Releases with the fix/.test(r.stdout)];
  }],
  ['"TTL is too far in the future" with the chains\' 14-day window (synthetic, on the preview block): pattern B', async () => {
    const r = await run(['--network', 'preview', '--offline', '--error', 'cannot apply regular transaction d3f88e6b08607a2d3e0179a07b92eded2518194de529fe2d3cf3e07fc52c96f2: malformed transaction: transaction application error detected during verification: Intent TTL is too far in the future. TTL: Timestamp(1786100145), Maximum allowed: Timestamp(1786100142)']);
    return [r.code === 0, /latest allowed 1786100142/.test(r.stdout), /checked it at the block's own time \(1784890542\)/.test(r.stdout), /Known pattern B/.test(r.stdout)];
  }],
  ['indexer v4.3.4 (Preview 128537, checked at block time + 12 s): pattern A, names v4.3.4 only', async () => {
    const r = await run(['--network', 'preview', '--offline', '--error', 'index_blocks_task failed: apply transactions to ledger state: cannot apply regular transaction 3864da188d7c1d85062c914f879e1e4c096d443abf139aa9717b5266945959e8: malformed transaction: transaction application error detected during verification: Intent TTL has expired. TTL: Timestamp(1784987084), Current block: Timestamp(1784987088)']);
    return [r.code === 0, /Block: 128537 /.test(r.stdout), /checked it at the block's own time \+ 12 s \(1784987088\)/.test(r.stdout), /Only indexer v4\.3\.4 does that/.test(r.stdout), !/v4\.3\.5 to/.test(r.stdout)];
  }],
  ['a ws:// node URL is read as http://', async () => {
    const r = await run(['--network', 'mainnet', '--offline', '--rpc', `${BASE.replace('http', 'ws')}/rpc/mainnet`, '--error', MAINNET_2998112]);
    return [r.code === 0, /note: read ws:\/\/.* as http:\/\//.test(r.stdout), /Block: 2998112 /.test(r.stdout)];
  }],
  ['the halt line with a height (indexer 4.3.800-rc.2 format) is used directly', async () => {
    const before = calls.length;
    const r = await run(['--network', 'mainnet', '--offline', '--rpc', `${BASE}/rpc/mainnet`, '--error', `apply transactions of block ${'ab'.repeat(32)} at height 2998112 to ledger state: ${MAINNET_2998112.replace('index_blocks_task failed: apply transactions to ledger state: ', '')}`]);
    const lookups = calls.slice(before).filter((c) => c.kind === 'rpc').length;
    // two block times and the runtime: no search, which would take about 80
    return [r.code === 0, /found by the height in the halt line/.test(r.stdout), lookups <= 8];
  }],
  ['a transaction invalid at both times is not a known pattern (exit 2)', async () => {
    const r = await run(['--network', 'mainnet', '--offline', '--rpc', `${BASE}/rpc/mainnet`, '--error', 'cannot apply regular transaction d9fd8f7fd5e1462f02bb862c437ad9b75e3f63ed55a3e84ec8d90fa2a44f3284: malformed transaction: transaction application error detected during verification: Intent TTL has expired. TTL: Timestamp(1791908880), Current block: Timestamp(1791908898)']);
    return [r.code === 2, /Not a known pattern/.test(r.stdout), !/Known pattern/.test(r.stdout)];
  }],
  ['input without a halt error (exit 2)', async () => {
    const r = await run(['--network', 'mainnet', '--error', 'chain-indexer exited with ERROR: database connection refused']);
    return [r.code === 2, /No halt error found/.test(r.stdout)];
  }],
  ['preprod without a token or a node: could not run (exit 1), says why', async () => {
    const r = await run(['--network', 'preprod', '--error', PREPROD_1461]);
    return [r.code === 1, /BLOCKFROST_PROJECT_ID/.test(r.stderr)];
  }],
  ['a node halted at the parent, no other source: names the next block, asks for another source (exit 3)', async () => {
    const r = await run(['--offline', '--error', `Imported #1788978\nImported #1788979\n${NODE_2229}`], { env: { CHECK_SYNC_HALT_LOCAL_RPC: `${BASE}/rpc/halted-mainnet` } });
    return [r.code === 3, /Halt: node on mainnet/.test(r.stdout), /Block: probably 1788980/.test(r.stdout), /pass --rpc with another node that is past block 1788980/.test(r.stdout)];
  }],
  ['nothing has the block: not found (exit 3)', async () => {
    const r = await run(['--network', 'preview', '--offline', '--error', NODE_2229.replace('1784643562', '1784987000').replace('1784643564', '1784987003')]);
    return [r.code === 3, /Block: not found/.test(r.stdout)];
  }],
  ['the same node halt, with a second source that has the block: pattern A', async () => {
    const r = await run(['--offline', '--rpc', `${BASE}/rpc/mainnet`, '--error', NODE_2229], { env: { CHECK_SYNC_HALT_LOCAL_RPC: `${BASE}/rpc/halted-mainnet` } });
    return [r.code === 0, /Block: 1788980 /.test(r.stdout), /Known pattern A/.test(r.stdout)];
  }],
  ['a local node on another network is not used, and says so', async () => {
    const r = await run(['--network', 'mainnet', '--offline', '--rpc', `${BASE}/rpc/mainnet`, '--error', MAINNET_2998112], { env: { CHECK_SYNC_HALT_LOCAL_RPC: `${BASE}/rpc/local-preview` } });
    return [r.code === 0, /answers for "Midnight Preview", so it isn't used/.test(r.stdout), /Block: 2998112 /.test(r.stdout)];
  }],
  ['no --network: inferred from the --rpc node', async () => {
    const r = await run(['--offline', '--rpc', `${BASE}/rpc/mainnet`, '--error', MAINNET_2998112]);
    return [r.code === 0, /Halt: indexer on mainnet/.test(r.stdout), /Block: 2998112 /.test(r.stdout)];
  }],
  ['an RPC that drops every other request: the retry gets the verdict anyway', async () => {
    const r = await run(['--network', 'mainnet', '--offline', '--rpc', `${BASE}/rpc/flaky-mainnet`, '--error', MAINNET_2998112]);
    return [r.code === 0, /Block: 2998112 /.test(r.stdout), /Known pattern A/.test(r.stdout)];
  }],
  ['an RPC that drops every block lookup: not found (exit 3), and says why', async () => {
    const r = await run(['--network', 'mainnet', '--offline', '--rpc', `${BASE}/rpc/dying-mainnet`, '--error', MAINNET_2998112]);
    return [r.code === 3, /Block: not found/.test(r.stdout), /dying-mainnet: .*(socket|other side closed|ECONNRESET|fetch failed)/i.test(r.stdout)];
  }],
  ['--json is valid JSON with the verdict', async () => {
    const r = await run(['--network', 'mainnet', '--offline', '--json', '--rpc', `${BASE}/rpc/mainnet`, '--error', MAINNET_2998112]);
    let j; try { j = JSON.parse(r.stdout); } catch { j = undefined; }
    return [r.code === 0, j?.results?.some((x) => x.verdict?.pattern === 'A' && x.loc.height === 2998112), j?.halt?.software === 'indexer'];
  }],
  ['--offline makes no GitHub or Docker Hub call', async () => {
    const before = calls.length;
    const r = await run(['--network', 'mainnet', '--offline', '--rpc', `${BASE}/rpc/mainnet`, '--error', MAINNET_2998112]);
    return [r.code === 0, !calls.slice(before).some((c) => c.kind === 'gh' || c.kind === 'hub')];
  }],
  ['--versions alone, GitHub rate-limited: exit 1 and says to set GITHUB_TOKEN; diagnosis still exits 0', async () => {
    rateLimitGithub = true;
    const v = await run(['--versions']);
    const d = await run(['--network', 'mainnet', '--rpc', `${BASE}/rpc/mainnet`, '--error', MAINNET_2998112]);
    rateLimitGithub = false;
    return [v.code === 1, /rate limit\? set GITHUB_TOKEN/.test(v.stdout), d.code === 0, /could not check/.test(d.stdout), /Known pattern A/.test(d.stdout)];
  }],
  ['--versions lists the fixed tags only (a pre-alpha or older tag is never counted)', async () => {
    const r = await run(['--versions']);
    return [r.code === 0, /midnight-indexer tags with the fix: v4\.3\.800-rc\.2\n/.test(r.stdout), !/pre-alpha/.test(r.stdout),
      /chain-indexer: images with the fix: 4\.3\.800-rc\.2; `latest` is 4\.3\.7, without the fix/.test(r.stdout)];
  }],
  ['bad arguments: exit 1', async () => {
    const a = await run(['--network', 'testnet', '--error', MAINNET_2998112]);
    const b = await run(['--bogus']);
    const c = await run(['--network', 'mainnet', '--log', '/nonexistent/halt.log']);
    return [a.code === 1, b.code === 1, c.code === 1, /cannot read/.test(c.stderr)];
  }],
];

let failed = 0;
for (const [name, fn] of cases) {
  let checks;
  const t0 = Date.now();
  try { checks = await fn(); } catch (e) { checks = [false]; console.log(`  error: ${e.message}`); }
  const ok = checks.every(Boolean);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)${ok ? '' : ` (failed checks: ${checks.map((c, i) => (c ? null : i)).filter((i) => i !== null).join(', ')})`}`);
}
server.close();
console.log(`\n${cases.length - failed} of ${cases.length} cases passed.`);
process.exitCode = failed ? 2 : 0;
