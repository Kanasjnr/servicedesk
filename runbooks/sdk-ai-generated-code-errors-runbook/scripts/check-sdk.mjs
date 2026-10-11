#!/usr/bin/env node
/**
 * check-sdk.mjs: read-only check of a DApp's Midnight SDK usage. Does every Midnight package it
 * depends on exist, at that version, in the generation the networks run? Does every name it imports
 * from them exist there? It catches what AI-written TypeScript gets wrong before `npm install` or
 * `tsc` does, and says what to use instead.
 *
 * It reads package.json, tsconfig*.json, .npmrc and .yarnrc(.yml) files and .ts/.tsx/.js/.jsx/.mjs/.cjs
 * sources under the paths given (not node_modules, dist or build) and compares them with sdk-index.json, which lists every export of the
 * network set (midnight-js 4.1.1, wallet SDK 1.2.0, compact-runtime 0.16.0, dapp-connector-api 4.0.1,
 * testkit-js 4.1.1) and of the 3.x-era generation AI tools learned, plus every published version of
 * each package. Nothing is installed, compiled, written or sent.
 *
 * Requirements: Node >= 20. No npm install. sdk-index.json next to this script.
 *
 * Usage:
 *   node check-sdk.mjs [file or directory …]        (default: the current directory)
 *   node check-sdk.mjs --explain "<npm, tsc or Node error text>"
 *   node check-sdk.mjs --index <path to sdk-index.json> …
 *
 * Exit code: 0 = nothing found (or the error was explained), 2 = findings (or the error isn't one this
 * script knows), 1 = could not run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'usage: node check-sdk.mjs [paths…] | --explain "<error text>" [--index <sdk-index.json>]';
const SCOPES = ['@midnight-ntwrk/', '@midnightntwrk/'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage', '.turbo', '.cache']);
const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TOOLCHAIN = 'the toolchain runbook (runbooks/toolchain-version-mismatch-runbook)';

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

// ---------- arguments ----------
const argv = process.argv.slice(2);
let explainText;
let indexPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sdk-index.json');
const targets = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--help' || a === '-h') {
    console.log(USAGE);
    process.exit(0);
  } else if (a === '--explain') {
    explainText = argv[++i];
    if (explainText === undefined) fail(`--explain needs the error text\n${USAGE}`);
  } else if (a === '--index') {
    indexPath = argv[++i];
    if (!indexPath) fail(`--index needs a path\n${USAGE}`);
  } else if (a.startsWith('--')) fail(`unknown option ${a}\n${USAGE}`);
  else targets.push(a);
}

let IDX;
try {
  IDX = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
} catch (e) {
  fail(`can't read ${indexPath}: ${e.message}`);
}
const CUR = IDX.current.modules; // specifier → [names]
const OLD = IDX.legacy.modules;
const PKGS = IDX.packages; // name → { latest, versions }
const CURV = IDX.current.versions; // package → version in the network set

// ---------- knowledge that the index can't infer (each one reproduced, see the NOTES) ----------
const pkgOf = (spec) => spec.split('/').slice(0, 2).join('/');
const shortOf = (name) => name.split('/')[1];
const twin = (name) => (name.startsWith('@midnight-ntwrk/') ? name.replace('@midnight-ntwrk/', '@midnightntwrk/') : name.replace('@midnightntwrk/', '@midnight-ntwrk/'));

// Old-generation packages: they install, but the networks' stack doesn't use them.
const LEGACY_PACKAGES = {
  wallet: 'the pre-2026 wallet API (`WalletBuilder`, last published 2025-05-12). The networks use the wallet SDK: `@midnight-ntwrk/wallet-sdk` 1.2.0, with `WalletFacade.init(…)`',
  'wallet-api': 'the interface of that old wallet. Use the wallet SDK (`@midnight-ntwrk/wallet-sdk` 1.2.0)',
  ledger: 'ledger 4 (2025). The networks run ledger 8: `@midnight-ntwrk/ledger-v8`, or `@midnight-ntwrk/midnight-js-protocol/ledger` from midnight-js',
  'ledger-v6': 'ledger 6. The networks run ledger 8: `@midnight-ntwrk/ledger-v8` (or `@midnight-ntwrk/midnight-js-protocol/ledger`)',
  'ledger-v7': 'ledger 7. The networks run ledger 8: `@midnight-ntwrk/ledger-v8` (or `@midnight-ntwrk/midnight-js-protocol/ledger`)',
  zswap: 'the old standalone zswap package. Its types are in `@midnight-ntwrk/ledger-v8` now',
  'onchain-runtime': 'an on-chain runtime two generations old. compact-runtime 0.16.0 brings `@midnight-ntwrk/onchain-runtime-v3`; don\'t install it yourself',
  'onchain-runtime-v1': 'an old on-chain runtime. compact-runtime 0.16.0 brings `@midnight-ntwrk/onchain-runtime-v3`',
  'onchain-runtime-v2': 'an old on-chain runtime. compact-runtime 0.16.0 brings `@midnight-ntwrk/onchain-runtime-v3`',
  'midnight-js-testing': 'an old test package (2.x). The network set uses `@midnight-ntwrk/testkit-js` 4.1.1',
};
// Names that aren't on npm at all.
const NOT_ON_NPM = {
  'compact-compiler': 'The Compact compiler isn\'t an npm package. Install the `compact` CLI and build with `compact compile +0.31.1 …`.',
  compactc: 'The Compact compiler isn\'t an npm package. Install the `compact` CLI and build with `compact compile +0.31.1 …`.',
  compact: 'The Compact compiler isn\'t an npm package. Install the `compact` CLI and build with `compact compile +0.31.1 …`.',
  zkir: 'The package is `@midnight-ntwrk/zkir-v2`, and midnight-js already depends on it.',
};
// Packages outside the Midnight scopes that AI tools name wrongly.
const THIRD_PARTY = {
  '@openzeppelin-compact/contracts-simulator': 'isn\'t on npm (404). The package is `@openzeppelin/compact-simulator`; 0.3.1 is the version built on compact-runtime 0.16.0, the network set\'s (0.4.x needs compact-runtime 0.19.0)',
};

// Names that changed between the generation AI tools learned and the network set.
const RENAMES = {
  ImpureCircuitId: 'compact-js 2.4.0 called it `ImpureCircuitId`; 2.5.1 has `ProvableCircuitId` (use it as `Contract.ProvableCircuitId<C>` from `@midnight-ntwrk/compact-js`, or `@midnight-ntwrk/midnight-js-protocol/compact-js`)',
  constructorContext: 'compact-runtime 0.9.0 had `constructorContext`; 0.16.0 has `createConstructorContext`',
  DAppConnectorAPI: 'that is dapp-connector-api 1.x–3.0 (the object at `window.midnight.<key>`, with `enable()`). 4.0.1 has `InitialAPI` (the object at `window.midnight.<wallet id>`); its `connect(networkId)` returns a `ConnectedAPI`',
  DAppConnectorWalletAPI: 'that is dapp-connector-api 1.x–3.0 (what `enable()` returned). In 4.0.1 the connected wallet is a `ConnectedAPI`, returned by `InitialAPI.connect(networkId)`',
  UnprovenTransaction: 'midnight-js-types 2.x and earlier re-exported the ledger\'s `UnprovenTransaction`; 3.x and 4.x don\'t. midnight-js 4.x passes an `UnboundTransaction` (from `@midnight-ntwrk/midnight-js-types`) to `WalletProvider.balanceTx`; the ledger\'s `UnprovenTransaction` is in `@midnight-ntwrk/midnight-js-protocol/ledger`',
};

// Source patterns that compile against the old generation but not the network set.
const SHAPE_RULES = [
  {
    id: 'new-wallet-facade',
    re: /\bnew\s+WalletFacade\s*\(/,
    msg: '`WalletFacade`\'s constructor is private in wallet-sdk-facade 4.x (TS2673). Create it with `await WalletFacade.init({ configuration, shielded: () => shieldedWallet, unshielded: () => unshieldedWallet, dust: () => dustWallet })`: the three wallets are passed as functions.',
  },
  {
    id: 'history-storage-no-args',
    re: /new\s+InMemoryTransactionHistoryStorage\s*\(\s*\)/,
    msg: '`InMemoryTransactionHistoryStorage` takes a schema (TS2554 without one): `new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries)`, all three from `@midnight-ntwrk/wallet-sdk`.',
  },
  {
    id: 'dust-wallet-balance',
    re: /\.walletBalance\b/,
    msg: 'The DUST wallet state has no `walletBalance`. Use `state.dust.balance(new Date())`, from `wallet.state()` or `await wallet.waitForSyncedState()`.',
  },
  {
    id: 'contract-index-cjs',
    re: /contract\/(?:out\/contract\/)?index\.cjs['"]/,
    msg: 'Compact 0.28 and later write the compiled contract as `contract/index.js` (an ES module), not `index.cjs`. Import `…/contract/index.js`.',
  },
  {
    id: 'generic-proof-provider',
    re: /\bProofProvider\s*</,
    msg: '`ProofProvider` isn\'t generic in midnight-js 4.x (TS2315). Drop the type argument.',
  },
  {
    id: 'async-key-getter',
    re: /\b(?:getCoinPublicKey|getEncryptionPublicKey)\s*(?::\s*async\b|\(\s*\)\s*:\s*Promise\b)|\basync\s+(?:getCoinPublicKey|getEncryptionPublicKey)\s*\(/,
    msg: '`WalletProvider.getCoinPublicKey()` and `getEncryptionPublicKey()` are synchronous in midnight-js (3.x and 4.x); an async one fails with TS2322. Read the keys first (for example `await connectedApi.getShieldedAddresses()`), then return them from plain functions.',
  },
  {
    id: 'charged-state-data',
    re: /currentQueryContext\.state\.data\b/,
    msg: '`currentQueryContext.state` is a `ChargedState`, which has no `data` (only `state`). Pass it straight to the contract\'s `ledger()`, which accepts a `ChargedState`: `ledger(ctx.currentQueryContext.state)`.',
  },
  {
    id: 'wallet-builder',
    re: /\bWalletBuilder\s*\.\s*(?:build|buildFromSeed|restore)\b/,
    msg: '`WalletBuilder.build…` is the old `@midnight-ntwrk/wallet` API. Use the wallet SDK: `HDWallet` from `@midnight-ntwrk/wallet-sdk-hd` for keys, then `WalletFacade.init(…)`.',
  },
];

// Checks that need more than one line; their messages are shared with --explain.
const FILE_RULES = {
  'connector-enable': '`enable()` is the dapp-connector-api 1.x–3.0 API. In 4.0.1 the object at `window.midnight.<wallet id>` is an `InitialAPI`: call `await initial.connect(networkId)` (for example `connect(\'preprod\')`), which returns the `ConnectedAPI` (TS2339 `Property \'enable\' does not exist on type \'InitialAPI\'` once the package\'s types load).',
  'window-midnight-declaration': 'dapp-connector-api 4.0.1 already declares `window.midnight` as `{ [key: string]: InitialAPI }`. A declaration with any other type fails with TS2717 (`Subsequent property declarations must have the same type`) wherever the package\'s types load, as in Vite and other `bundler` setups. Declare it exactly that way, or not at all.',
  'connector-nodenext': '`@midnight-ntwrk/dapp-connector-api` 4.0.1 re-exports `./api`, `./errors` and `./globals` without file extensions, and TypeScript\'s NodeNext (and Node16) resolution doesn\'t load them. `window.midnight` is then undeclared (TS2339), and with `skipLibCheck` every type the package exports (`InitialAPI`, `ConnectedAPI` …) is silently `any`, so wrong wallet calls compile; without `skipLibCheck`, tsc reports TS2834 inside the package. Typecheck browser code with `"moduleResolution": "bundler"` (what Vite uses), where the types load. Status: fixed upstream in midnightntwrk/midnight-dapp-connector-api#61 (merged 2026-08-05) but in no stable release as of 2026-10-11 (only the `canary` builds from 2026-08-19 have it). To see whether the installed version has the fix, open `node_modules/@midnight-ntwrk/dapp-connector-api/dist/index.d.ts`: `from \'./api.js\'` means fixed, `from \'./api\'` means not.',
};
const rule = (id) => SHAPE_RULES.find((r) => r.id === id)?.msg ?? FILE_RULES[id];

// ---------- helpers ----------
const lev = (a, b) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};
const closest = (name, pool, max = 3) =>
  [...new Set(pool)]
    .map((n) => [n, lev(name.toLowerCase(), n.toLowerCase())])
    .filter(([n, d]) => d <= Math.max(2, Math.floor(name.length / 4)) || n.toLowerCase().includes(name.toLowerCase()))
    .sort((a, b) => a[1] - b[1])
    .slice(0, max)
    .map(([n]) => n);
const has = (spec, name) => (CUR[spec] ?? []).includes(name);
// Prefer the package's own root, then other roots, then subpaths.
const whereCurrent = (name) =>
  Object.keys(CUR)
    .filter((s) => has(s, name))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
const whereLegacy = (name) => Object.keys(OLD).filter((s) => (OLD[s] ?? []).includes(name));
const vparts = (v) => v.split('-')[0].split('.').map(Number);
const vcmp = (a, b) => {
  const [x, y] = [vparts(a), vparts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return a.includes('-') === b.includes('-') ? 0 : a.includes('-') ? -1 : 1;
};
// Minimal npm range check: ^, ~, x/*, >=, exact. Returns undefined for ranges it doesn't parse.
function satisfies(v, range) {
  const r = range.trim();
  if (v.includes('-')) return false; // npm only picks prereleases when asked
  if (r === '*' || r === '' || r === 'latest' || r === 'x') return true;
  let m;
  if ((m = r.match(/^\^(\d+)\.(\d+)\.(\d+)$/))) {
    const [a, b, c] = m.slice(1).map(Number);
    const [x, y, z] = vparts(v);
    if (vcmp(v, `${a}.${b}.${c}`) < 0) return false;
    return a > 0 ? x === a : b > 0 ? x === 0 && y === b : x === 0 && y === 0 && z === c;
  }
  if ((m = r.match(/^~(\d+)\.(\d+)\.(\d+)$/))) {
    const [a, b] = m.slice(1).map(Number);
    const [x, y] = vparts(v);
    return x === a && y === b && vcmp(v, m[0].slice(1)) >= 0;
  }
  if ((m = r.match(/^(\d+)(?:\.(\d+|x|\*))?(?:\.(x|\*))?$/)) && (m[2] === undefined || /x|\*/.test(m[2] ?? '') || m[3])) {
    const [x, y] = vparts(v);
    return x === Number(m[1]) && (m[2] === undefined || /x|\*/.test(m[2]) || y === Number(m[2]));
  }
  if ((m = r.match(/^>=\s*(\d+\.\d+\.\d+)$/))) return vcmp(v, m[1]) >= 0;
  return undefined;
}
// What npm installs for a range: the `latest` tag if it satisfies the range, else the highest match.
function resolveRange(info, range) {
  if (!info) return undefined;
  if (info.latest && satisfies(info.latest, range)) return info.latest;
  const ok = info.versions.filter((v) => satisfies(v, range) === true).sort(vcmp);
  return ok.length ? ok[ok.length - 1] : undefined;
}
const parseVersion = (spec) => spec.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0];

// A package, as named in a dependency or an import: what's wrong with it, if anything.
function packageProblem(name) {
  const short = shortOf(name);
  if (THIRD_PARTY[name]) return { kind: 'missing', msg: `\`${name}\` ${THIRD_PARTY[name]}.` };
  if (name.startsWith('@midnight/')) return { kind: 'missing', msg: `\`${name}\` isn't on npm (404): there is no \`@midnight\` scope. Midnight packages are \`@midnight-ntwrk/…\` (and the wallet SDK also \`@midnightntwrk/…\`); for the ledger use \`@midnight-ntwrk/midnight-js-protocol/ledger\`.` };
  if (!PKGS[name]) {
    const near = closest(short, Object.keys(PKGS).filter((n) => n.startsWith('@midnight-ntwrk/')).map(shortOf));
    const similar = near.length ? ` Real packages with a similar name: ${near.map((n) => `\`@midnight-ntwrk/${n}\``).join(', ')}.` : '';
    if ((IDX.missing ?? []).includes(name)) {
      return { kind: 'missing', msg: `\`${name}\` isn't on npm (npm install: 404 Not Found; checked ${IDX.generated}).${NOT_ON_NPM[short] ? ` ${NOT_ON_NPM[short]}` : similar}` };
    }
    if (PKGS[twin(name)]) return { kind: 'missing', msg: `\`${name}\` isn't on npm; the package is published as \`${twin(name)}\`.` };
    return { kind: 'unknown', msg: `\`${name}\` isn't a package this index knows (generated ${IDX.generated}); check it with \`npm view ${name}\`.${similar}` };
  }
  if (LEGACY_PACKAGES[short]) return { kind: 'legacy', msg: `\`${name}\` is ${LEGACY_PACKAGES[short]}.` };
  return null;
}

// A named import: what's wrong with it, if anything. spec is the module specifier as written.
function nameProblem(spec, name) {
  const pkg = pkgOf(spec);
  const lookup = CUR[spec] ? spec : CUR[twin(spec)] ? twin(spec) : null;
  if (!lookup) return null; // module-level problem reported separately
  if (has(lookup, name)) return null;
  const elsewhere = whereCurrent(name);
  const before = whereLegacy(name);
  if (RENAMES[name]) return `\`${name}\` isn't exported by \`${spec}\`: ${RENAMES[name]}.`;
  if (elsewhere.length) {
    const same = elsewhere.filter((s) => pkgOf(s) === pkg);
    const best = (same.length ? same : elsewhere).slice(0, 2);
    const was = before.includes(lookup) ? ` (${pkg} ${IDX.legacy.versions[pkg] ?? 'before'} exported it here)` : '';
    return `\`${name}\` isn't exported by \`${spec}\`${was}. Import it from ${best.map((s) => `\`${s}\``).join(' or ')}.`;
  }
  const near = closest(name, CUR[lookup]);
  if (before.length) {
    return `\`${name}\` was exported by \`${before[0]}\` in the older generation (${pkgOf(before[0])} ${IDX.legacy.versions[pkgOf(before[0])] ?? ''}) and no network-set package has it now.${near.length ? ` \`${spec}\` has ${near.map((n) => `\`${n}\``).join(', ')}.` : ''}`;
  }
  return `No Midnight package exports \`${name}\`, in the network set or the generation before it.${near.length ? ` \`${spec}\` has ${near.map((n) => `\`${n}\``).join(', ')}.` : ' It looks invented.'}`;
}

// A module specifier: package problems, then unknown subpaths.
function moduleProblem(spec) {
  const pkg = pkgOf(spec);
  const p = packageProblem(pkg);
  if (p) return p.msg;
  if (CUR[spec] || CUR[twin(spec)]) return null;
  const subs = Object.keys(CUR).filter((s) => pkgOf(s) === pkg || pkgOf(s) === twin(pkg));
  if (subs.length && spec !== pkg) {
    return `\`${pkg}\` doesn't export the subpath \`${spec.slice(pkg.length)}\` (Node: ERR_PACKAGE_PATH_NOT_EXPORTED). Its entry points: ${subs.slice(0, 8).map((s) => `\`${s}\``).join(', ')}${subs.length > 8 ? ' …' : ''}.`;
  }
  if (!subs.length && PKGS[pkg]) return null; // real package outside the indexed set (e.g. DID or credential packages)
  return null;
}

// ---------- --explain ----------
function explain(text) {
  const out = [];
  const t = text.replace(/\s+/g, ' ');
  let m;
  // tsc: no exported member / did you mean / declared locally / Node ESM: does not provide an export
  for (const re of [
    /Module ['"]{1,2}(@midnight-?ntwrk\/[^'"]+)['"]{1,2} has no exported member(?: named)? '([^']+)'/g,
    /['"]{1,2}(@midnight-?ntwrk\/[^'"]+)['"]{1,2} has no exported member named '([^']+)'/g,
    /Module ['"]{1,2}(@midnight-?ntwrk\/[^'"]+)['"]{1,2} declares '([^']+)' locally, but it is not exported/g,
    /requested module '(@midnight-?ntwrk\/[^']+)' does not provide an export named '([^']+)'/g,
  ]) {
    while ((m = re.exec(t))) out.push(nameProblem(m[1], m[2]) ?? `\`${m[1]}\` does export \`${m[2]}\` in the network set: the installed version is a different one. Check \`npm ls ${pkgOf(m[1])}\` against ${TOOLCHAIN}.`);
  }
  for (const re of [/Cannot find module '(@midnight-?ntwrk\/[^']+)'/g, /Cannot find package '(@midnight-?ntwrk\/[^']+)'/g]) {
    while ((m = re.exec(t))) out.push(moduleProblem(m[1]) ?? `\`${m[1]}\` exists in the network set; it just isn't installed. Add it at version ${CURV[pkgOf(m[1])] ?? 'the support-matrix version'}.`);
  }
  if ((m = t.match(/Package subpath '([^']+)' is not defined by "exports" in .*?node_modules\/(@midnight-?ntwrk\/[^/]+)\//))) {
    out.push(moduleProblem(`${m[2]}/${m[1].replace(/^\.\//, '')}`) ?? `\`${m[2]}\` has no \`${m[1]}\` entry point.`);
  }
  if ((m = t.match(/No matching version found for (@midnight-?ntwrk\/[a-z0-9-]+)@([^\s.]+(?:\.[^\s.]+)*)\.?/))) {
    const [name, ver] = [m[1], m[2].replace(/\.$/, '')];
    const info = PKGS[name];
    const near = info ? info.versions.filter((v) => !v.includes('-')).filter((v) => v.split('.')[0] === ver.split('.')[0]).slice(-4) : [];
    out.push(`\`${name}@${ver}\` was never published.${near.length ? ` Published ${ver.split('.')[0]}.x versions: ${near.join(', ')}.` : ''} The network set uses ${CURV[name] ?? CURV[twin(name)] ?? info?.latest ?? 'the support-matrix version'}.`);
  }
  if ((m = t.match(/404 Not Found - GET https:\/\/registry\.npmjs\.org\/(@midnight-?ntwrk)%2f([a-z0-9-]+)/)) || (m = t.match(/'(@midnight-?ntwrk)\/([a-z0-9-]+)@[^']*' is not in this registry/))) {
    out.push(packageProblem(`${m[1]}/${m[2]}`)?.msg ?? `\`${m[1]}/${m[2]}\` is on npm; check the spelling and the registry configuration (.npmrc).`);
  }
  if (/checkRuntimeVersion is not a function/.test(t)) {
    out.push('The installed `@midnight-ntwrk/compact-runtime` is older than the compiler that built the contract: it predates the version check that compiled contracts call on import (0.9.0 has none). Contracts from compiler 0.31.1 need compact-runtime 0.16.0. Install exactly that, with midnight-js 4.1.1, and see ' + TOOLCHAIN + '.');
  }
  if (/unknown network ID: 109/.test(t)) out.push('An old-generation package (`@midnight-ntwrk/ledger` 4, `zswap` 4 or the old `@midnight-ntwrk/wallet`) is reading data from a newer one: the old reader takes the first byte of the `midnight:` tag (109 is `m`) as a network ID (midnight-wallet#162). Remove the old packages and use the network set.');
  if (/addIntent is not a function/.test(t)) out.push('An older `@midnight-ntwrk/ledger-v8` than midnight-js 4.1.1 expects is installed (often an `overrides` pin to 8.0.x): the wallet SDK calls `Transaction.fromParts(…).addIntent`, which 8.0.x lacks (servicedesk#81, #79). Remove the pin so ledger-v8 is 8.1.x, and see ' + TOOLCHAIN + '.');
  if (/setContractAddress is not a function/.test(t)) out.push('A custom private-state provider is missing `setContractAddress`, which `PrivateStateProvider` has required since midnight-js 3.1.0 (midnight-js#853). Implement the whole interface or use `levelPrivateStateProvider`.');
  if (/pendingOutputs\.values\.map is not a function/.test(t)) out.push('Two reported causes; check both. An old shielded wallet: midnight-wallet#648 (open) hits it with `@midnight-ntwrk/wallet-sdk-shielded` 2.1.0 once the wallet has a pending output, and the network set has 3.0.2, from `@midnight-ntwrk/wallet-sdk` 1.2.0 (`npm ls @midnight-ntwrk/wallet-sdk-shielded`). And Node 20: the docs give it as the Node 20 crash signature and require Node 22 (midnight-docs#1135); the SDK packages declare no `engines`, so npm doesn\'t warn (`node --version`).');
  if (/npm\.pkg\.github\.com/.test(t) && /(Invalid authentication|E401|E403|401|403)/.test(t)) out.push('The Midnight scope is pointed at GitHub Packages (in .npmrc or .yarnrc.yml). The packages are on public npm; remove that registry setting.');
  if (/Property 'midnight' does not exist on type 'Window/.test(t) || /dapp-connector-api\/dist\/index\.d\.ts.*TS2834/.test(t)) out.push(rule('connector-nodenext'));
  if (/Property 'midnight' must be of type '\{ \[key: string\]: InitialAPI; \}'/.test(t)) out.push(rule('window-midnight-declaration'));
  if (/Property 'enable' does not exist on type 'InitialAPI'/.test(t)) out.push(rule('connector-enable'));
  if (/Version mismatch: compiled code expects/.test(t)) out.push(`The compiled contract and the installed compact-runtime don't match. See ${TOOLCHAIN}.`);
  if (/Constructor of class 'WalletFacade' is private/.test(t)) out.push(rule('new-wallet-facade'));
  if (/Property 'walletBalance' does not exist/.test(t)) out.push(rule('dust-wallet-balance'));
  if (/Type 'ProofProvider' is not generic/.test(t)) out.push(rule('generic-proof-provider'));
  if (/Property 'data' does not exist on type 'ChargedState'/.test(t)) out.push(rule('charged-state-data'));
  if (/Type '\(\) => Promise<[^>]*>' is not assignable to type '\(\) => string'/.test(t)) out.push(rule('async-key-getter'));
  if (/'walletProvider' does not exist in type 'Partial<LevelPrivateStateProviderConfig>/.test(t)) {
    out.push('`levelPrivateStateProvider` takes no `walletProvider`. In midnight-js 4.x it needs `privateStoragePasswordProvider` (an async function returning the password that encrypts the store) and `accountId` (for example the wallet address), plus an optional `privateStateStoreName`.');
  }
  if (/LevelPrivateStateProviderConfig, "privateStoragePasswordProvider" \| "accountId">/.test(t) && !/'walletProvider'/.test(t)) {
    out.push('`levelPrivateStateProvider` in midnight-js 4.x requires `privateStoragePasswordProvider` (an async function returning the store password) and `accountId` (for example the wallet address).');
  }
  return [...new Set(out)];
}

// ---------- local packages: workspace members and every package.json scanned ----------
const LOCAL = new Set();
function readJson(f) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return undefined;
  }
}
function expandWorkspace(root, pattern) {
  const parts = pattern.replace(/\/$/, '').split('/');
  let dirs = [root];
  for (const part of parts) {
    const next = [];
    for (const d of dirs) {
      if (part === '*' || part === '**') {
        try {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory() && !SKIP_DIRS.has(e.name)) next.push(path.join(d, e.name));
        } catch {}
      } else next.push(path.join(d, part));
    }
    dirs = next;
  }
  return dirs;
}
function collectLocal(target) {
  for (let d = path.resolve(fs.statSync(target).isDirectory() ? target : path.dirname(target)); ; d = path.dirname(d)) {
    const pkg = readJson(path.join(d, 'package.json'));
    const ws = pkg && (Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages);
    if (ws) {
      for (const pat of ws) for (const dir of expandWorkspace(d, pat)) {
        const name = readJson(path.join(dir, 'package.json'))?.name;
        if (name) LOCAL.add(name);
      }
    }
    if (path.dirname(d) === d) break;
  }
}

// ---------- scanning ----------
const findings = [];
let usesConnector = false; // set when a scanned file imports or depends on dapp-connector-api
const nodeNextConfigs = []; // tsconfig files that resolve modules the NodeNext/Node16 way
const add = (file, line, msg) => findings.push({ file, line, msg });

function walk(p, files) {
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    fail(`no such file or directory: ${p}`);
  }
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
      walk(path.join(p, e.name), files);
    }
  } else if (['package.json', '.npmrc', '.yarnrc.yml', '.yarnrc'].includes(path.basename(p)) || /^tsconfig.*\.json$/.test(path.basename(p)) || SOURCE_EXT.test(p)) files.push(p);
  return files;
}

// A scope registry for the Midnight packages: they're on public npm, and agents add these by mistake.
function checkRegistryConfig(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const yarn = file.endsWith('.yml');
  lines.forEach((l, i) => {
    const hit = yarn ? /^\s*["']?midnight-?ntwrk["']?\s*:/.test(l) || /npmScopes/.test(l) && /midnight/.test(lines.slice(i, i + 3).join(' ')) : /@midnight-?ntwrk:registry\s*=/.test(l);
    if (hit) add(file, i + 1, 'This points the Midnight scope at a custom registry. The packages are on public npm (registry.npmjs.org); a GitHub Packages registry here fails with 401/403 "Invalid authentication". Remove it.');
  });
}

// tsconfig: NodeNext/Node16 resolution can't load dapp-connector-api 4.0.1's types (reported after the scan, if the
// project uses the connector). `extends` isn't followed; a config that sets neither option is left alone.
// If the connector is installed next to the config, its index.d.ts decides: extensionless relative imports are the
// bug, `.js` ones the fix (midnight-dapp-connector-api#61), so the finding goes away once a fixed version is installed.
function installedConnector(fromDir) {
  for (let d = path.resolve(fromDir); ; d = path.dirname(d)) {
    for (const scope of ['@midnight-ntwrk', '@midnightntwrk']) {
      const dir = path.join(d, 'node_modules', scope, 'dapp-connector-api');
      const dts = path.join(dir, 'dist', 'index.d.ts');
      if (fs.existsSync(dts)) {
        const specs = [...fs.readFileSync(dts, 'utf8').matchAll(/(?:from|import)\s+['"](\.\.?\/[^'"]+)['"]/g)].map((x) => x[1]);
        return { version: readJson(path.join(dir, 'package.json'))?.version, broken: specs.some((x) => !/\.(?:m|c)?js$|\.json$/.test(x)) };
      }
    }
    if (path.dirname(d) === d) return null;
  }
}
function checkTsconfig(file) {
  const text = fs.readFileSync(file, 'utf8');
  let cfg;
  try {
    cfg = JSON.parse(text.replace(/\/\*[\s\S]*?\*\/|(^|[^:"])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return;
  }
  const o = cfg?.compilerOptions ?? {};
  const res = String(o.moduleResolution ?? (/^node(16|next)$/i.test(String(o.module ?? '')) ? o.module : '')).toLowerCase();
  if (res === 'nodenext' || res === 'node16') {
    const line = text.split('\n').findIndex((l) => /"moduleResolution"|"module"/.test(l) && /node(16|next)/i.test(l)) + 1;
    nodeNextConfigs.push({ file, line });
  }
}

function checkPackageJson(file) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return;
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies };
  const text = fs.readFileSync(file, 'utf8').split('\n');
  const lineOf = (name) => text.findIndex((l) => l.includes(`"${name}"`)) + 1;
  const names = Object.keys(deps).filter((n) => SCOPES.some((s) => n.startsWith(s)) || n.startsWith('@midnight/') || THIRD_PARTY[n]);
  if (names.some((n) => shortOf(n) === 'dapp-connector-api')) usesConnector = true;
  for (const name of names) {
    const range = String(deps[name]);
    if (LOCAL.has(name) || /^(workspace|file|link|portal):/.test(range)) continue;
    const p = packageProblem(name);
    if (p) {
      add(file, lineOf(name), p.msg);
      continue;
    }
    const info = PKGS[name] ?? PKGS[twin(name)];
    const ver = parseVersion(range);
    if (!info || !ver || /^(file|link|workspace|git|https?):/.test(range)) continue;
    const exact = /^\d/.test(range.trim()) || range.trim().startsWith('=');
    if (exact && !info.versions.includes(ver)) {
      const near = info.versions.filter((v) => !v.includes('-') && v.split('.')[0] === ver.split('.')[0]).slice(-4);
      add(file, lineOf(name), `\`${name}@${ver}\` was never published (npm install: No matching version found).${near.length ? ` Published ${ver.split('.')[0]}.x versions: ${near.join(', ')}.` : ''} The network set uses ${CURV[name] ?? CURV[twin(name)] ?? info.latest}.`);
      continue;
    }
    const want = CURV[name] ?? CURV[twin(name)];
    if (!want) continue;
    if (!exact) {
      const got = resolveRange(info, range);
      const [gMaj, gMin] = got ? vparts(got) : [];
      const [wantMaj, wantMin] = vparts(want);
      if (got && (gMaj < wantMaj || (gMaj === wantMaj && gMin < wantMin))) {
        const why = got === info.latest
          ? `npm installs the \`latest\` tag (${info.latest}) whenever it fits the range, and that tag lags behind`
          : `the range stops below ${want}`;
        const fix = /^wallet-sdk-/.test(shortOf(name))
          ? `Install the wallet SDK as one set instead: \`@midnight-ntwrk/wallet-sdk\` "${CURV['@midnight-ntwrk/wallet-sdk']}" (it brings ${shortOf(name)} ${want}).`
          : `Pin "${want}".`;
        add(file, lineOf(name), `\`${name}\`: "${range}" installs ${got}, not the network set's ${want}: ${why}. ${fix}`);
        continue;
      }
    }
    const [vMaj, vMin] = ver.split('.').map(Number);
    const [wMaj, wMin] = want.split('.').map(Number);
    if (vMaj < wMaj || (vMaj === 0 && wMaj === 0 && vMin < wMin)) {
      const runtimeNote = shortOf(name) === 'compact-runtime' ? ' A contract from compiler 0.31.1 needs compact-runtime 0.16.0 exactly; a much older runtime fails on import with `checkRuntimeVersion is not a function`.' : '';
      add(file, lineOf(name), `\`${name}\` ${range} is an older generation than the network set's ${want}; its API differs (the import findings show where).${runtimeNote} See ${TOOLCHAIN} for the full set to pin.`);
    }
  }
  const both = names.filter((n) => names.includes(twin(n)) && n.startsWith('@midnight-ntwrk/'));
  for (const n of both) add(file, lineOf(twin(n)), `\`${n}\` and \`${twin(n)}\` are both listed: two copies of the same package, which breaks \`instanceof\` checks between them. Keep one scope.`);
}

// import … from 'x' | export … from 'x' | import('x') | require('x'), with the named imports.
const IMPORT_RE = /(?:import\s+(type\s+)?([^'";]*?)\s+from\s+|export\s+(?:type\s+)?\{[^}]*\}\s+from\s+|import\s*\(\s*|require\s*\(\s*)['"]((?:@midnight-ntwrk|@midnightntwrk|@midnight|@openzeppelin-compact)\/[^'"]+)['"]/g;
function checkSource(file) {
  const src = fs.readFileSync(file, 'utf8');
  const lineAt = (i) => src.slice(0, i).split('\n').length;
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(src))) {
    const clause = m[2] ?? '';
    const spec = m[3];
    const line = lineAt(m.index);
    if (LOCAL.has(pkgOf(spec))) continue;
    const mp = moduleProblem(spec);
    if (mp) {
      add(file, line, mp);
      continue;
    }
    const braces = clause.match(/\{([^}]*)\}/);
    if (!braces) continue;
    const bracesAt = m.index + m[0].indexOf(braces[0]) + 1;
    let offset = 0;
    for (const raw of braces[1].split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      const at = bracesAt + offset + raw.indexOf(name);
      offset += raw.length + 1;
      if (!name || name === 'default') continue;
      const np = nameProblem(spec, name);
      if (np) add(file, lineAt(at), np);
    }
  }
  const lines = src.split('\n');
  lines.forEach((l, i) => {
    if (/^\s*(\/\/|\*)/.test(l)) return;
    for (const r of SHAPE_RULES) if (r.re.test(l)) add(file, i + 1, r.msg);
  });
  // DApp connector: the old enable() call, and Window.midnight declared with another type.
  if (/\bwindow\.midnight\b/.test(src)) {
    const enable = /\.enable\s*\(\s*\)/g;
    while ((m = enable.exec(src))) add(file, lineAt(m.index), rule('connector-enable'));
  }
  const win = /interface\s+Window\s*\{/g;
  while ((m = win.exec(src))) {
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (; end < src.length; end++) {
      if (src[end] === '{') depth++;
      else if (src[end] === '}' && --depth === 0) break;
    }
    const body = src.slice(m.index + m[0].length, end);
    const at = body.search(/\bmidnight\??\s*:/);
    if (at < 0) continue;
    const decl = body.slice(at).replace(/\s+/g, ' ');
    if (!/^midnight\??\s?:\s?(?:\{\s?\[\s?\w+\s?:\s?string\s?\]\s?:\s?InitialAPI\s?;?\s?\}|Record<\s?string\s?,\s?InitialAPI\s?>)/.test(decl)) {
      add(file, lineAt(m.index + m[0].length + at), rule('window-midnight-declaration'));
    }
  }
  if (/['"]@midnight-?ntwrk\/dapp-connector-api['"]/.test(src)) usesConnector = true;
  // levelPrivateStateProvider({ … }): the 4.x config needs two fields and takes no walletProvider.
  const re = /levelPrivateStateProvider\s*(?:<[^>]*>)?\s*\(/g;
  while ((m = re.exec(src))) {
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (; end < src.length; end++) {
      if (src[end] === '(') depth++;
      else if (src[end] === ')' && --depth === 0) break;
    }
    const argText = src.slice(m.index + m[0].length, end);
    if (!/\{/.test(argText)) continue; // config built elsewhere; tsc will say
    const missing = ['privateStoragePasswordProvider', 'accountId'].filter((k) => !new RegExp(`\\b${k}\\b`).test(argText));
    const wp = argText.search(/\bwalletProvider\b/);
    if (wp >= 0) add(file, lineAt(m.index + m[0].length + wp), '`levelPrivateStateProvider` takes no `walletProvider` (TS2353). It needs `privateStoragePasswordProvider` and `accountId` instead.');
    if (missing.length) add(file, lineAt(m.index), `\`levelPrivateStateProvider\` in midnight-js 4.x requires ${missing.map((k) => `\`${k}\``).join(' and ')}: \`privateStoragePasswordProvider\` is an async function returning the password that encrypts the store, \`accountId\` identifies the store (for example the wallet address).`);
  }
}

// ---------- main ----------
if (explainText !== undefined) {
  const out = explain(explainText);
  if (!out.length) {
    console.log('No explanation: this script only knows npm, tsc and Node errors about @midnight-ntwrk packages. For compiler or proof-server errors see the other runbooks in runbooks/README.md.');
    process.exit(2);
  }
  for (const o of out) console.log(`- ${o}`);
  process.exit(0);
}

const files = (targets.length ? targets : ['.']).flatMap((t) => walk(t, []));
for (const t of targets.length ? targets : ['.']) collectLocal(t);
for (const f of files) if (path.basename(f) === 'package.json') {
  const name = readJson(f)?.name;
  if (name) LOCAL.add(name);
}
for (const f of files) {
  try {
    if (path.basename(f) === 'package.json') checkPackageJson(f);
    else if (['.npmrc', '.yarnrc.yml', '.yarnrc'].includes(path.basename(f))) checkRegistryConfig(f);
    else if (/^tsconfig.*\.json$/.test(path.basename(f))) checkTsconfig(f);
    else checkSource(f);
  } catch (e) {
    add(f, 0, `could not read: ${e.message}`);
  }
}
if (usesConnector) {
  for (const c of nodeNextConfigs) {
    const inst = installedConnector(path.dirname(c.file));
    if (inst && !inst.broken) continue; // the installed version has the fix
    add(c.file, c.line, `${inst ? `Installed: dapp-connector-api ${inst.version}, whose index.d.ts still imports without extensions. ` : ''}${rule('connector-nodenext')}`);
  }
}
const fileOrder = new Map(files.map((f, i) => [f, i]));
const uniq = [...new Map(findings.map((f) => [`${f.file}:${f.line}:${f.msg}`, f])).values()].sort(
  (a, b) => (fileOrder.get(a.file) ?? 0) - (fileOrder.get(b.file) ?? 0) || a.line - b.line,
);
for (const f of uniq) console.log(`${f.file}:${f.line}: ${f.msg}`);
console.log(
  uniq.length
    ? `\n${uniq.length} finding(s) in ${new Set(uniq.map((f) => f.file)).size} of ${files.length} file(s), against the network set (midnight-js ${CURV['@midnight-ntwrk/midnight-js-contracts']}, wallet SDK ${CURV['@midnight-ntwrk/wallet-sdk']}, compact-runtime ${CURV['@midnight-ntwrk/compact-runtime']}; index ${IDX.generated}).`
    : `No problems found in ${files.length} file(s) (index ${IDX.generated}).`,
);
process.exit(uniq.length ? 2 : 0);
