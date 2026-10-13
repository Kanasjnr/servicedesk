#!/usr/bin/env node
/**
 * gen-sdk-index.mjs: build sdk-index.json, the data check-sdk.mjs reads.
 *
 * It lists every export (values and types) of every @midnight-ntwrk / @midnightntwrk package
 * installed in two projects, using the TypeScript compiler API:
 *
 *   --current <dir>  a project with the network set installed (midnight-js, wallet SDK, compact-runtime,
 *                    dapp-connector-api, testkit-js … at the support-matrix versions) and `typescript`
 *   --legacy <dir>   a project with the older generation installed (midnight-js 3.x, compact-runtime 0.9,
 *                    dapp-connector-api 3.0, wallet-sdk 1.0.x, ledger-v7, @midnight-ntwrk/wallet) and `typescript`
 *
 * and fetches every published version of each package name in both scopes from the npm registry.
 *
 * Usage: node gen-sdk-index.mjs --current <dir> --legacy <dir> [--out sdk-index.json]
 * Needs Node >= 20 and network access to registry.npmjs.org. Writes only --out.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
if (!args.current || !args.legacy) {
  console.error('usage: node gen-sdk-index.mjs --current <dir> --legacy <dir> [--out sdk-index.json]');
  process.exit(1);
}
const outFile = args.out ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'sdk-index.json');
const SCOPES = ['@midnight-ntwrk', '@midnightntwrk'];

// Every module specifier a project can import from: each package's "." plus its explicit subpath exports.
function specifiersOf(projectDir) {
  const specs = [];
  const versions = {};
  for (const scope of SCOPES) {
    const dir = path.join(projectDir, 'node_modules', scope);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, name, 'package.json'), 'utf8'));
      versions[pkg.name] = pkg.version;
      const exp = pkg.exports;
      const subpaths =
        exp && typeof exp === 'object' && !Array.isArray(exp) && Object.keys(exp).some((k) => k.startsWith('.'))
          ? Object.keys(exp).filter((k) => k.startsWith('.') && !k.includes('*') && !k.endsWith('package.json'))
          : ['.'];
      for (const sp of subpaths) specs.push(sp === '.' ? pkg.name : `${pkg.name}/${sp.slice(2)}`);
    }
  }
  return { specs, versions };
}

function exportsOf(projectDir) {
  const require = createRequire(path.join(path.resolve(projectDir), 'package.json'));
  const ts = require('typescript');
  const { specs, versions } = specifiersOf(projectDir);
  const probe = path.join(projectDir, '__sdk_index_probe.ts');
  fs.writeFileSync(probe, specs.map((s, i) => `import * as m${i} from '${s}';`).join('\n') + '\n');
  try {
    const program = ts.createProgram([probe], {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      skipLibCheck: true,
      noEmit: true,
      types: [],
    });
    const checker = program.getTypeChecker();
    const modules = {};
    for (const stmt of program.getSourceFile(probe).statements) {
      if (!ts.isImportDeclaration(stmt)) continue;
      const sym = checker.getSymbolAtLocation(stmt.moduleSpecifier);
      if (!sym) continue; // no types for this specifier
      modules[stmt.moduleSpecifier.text] = checker.getExportsOfModule(sym).map((e) => e.getName()).sort();
    }
    return { modules, versions, typescript: ts.version };
  } finally {
    fs.unlinkSync(probe);
  }
}

// Package names AI tools use that the installs don't contain: older generations, which exist on npm,
// and names that were never published. Both are checked against the registry at generation time.
const EXTRA_NAMES = ['wallet', 'wallet-api', 'ledger', 'ledger-v6', 'ledger-v7', 'ledger-v9', 'zswap', 'onchain-runtime', 'onchain-runtime-v1', 'onchain-runtime-v2', 'onchain-runtime-v4', 'midnight-js-testing', 'compact-js-command'];
const NEVER_PUBLISHED_CANDIDATES = ['compact-compiler', 'compactc', 'compact', 'zkir', 'midnight-js', 'midnight-sdk', 'midnight-js-wallet'];

async function searchScope(scope) {
  const names = new Set();
  for (let from = 0; from < 1000; from += 250) {
    const r = await fetch(`https://registry.npmjs.org/-/v1/search?text=scope:${scope}&size=250&from=${from}`, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) break;
    const j = await r.json();
    for (const o of j.objects ?? []) if (o.package.name.startsWith(`@${scope}/`)) names.add(o.package.name);
    if ((j.objects ?? []).length < 250) break;
  }
  return names;
}

async function registry(names) {
  const out = {};
  const one = async (name) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}`, {
          headers: { accept: 'application/vnd.npm.install-v1+json' },
          signal: AbortSignal.timeout(60_000),
        });
        if (r.status === 404) return;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        out[name] = { latest: j['dist-tags']?.latest ?? null, versions: Object.keys(j.versions ?? {}) };
        return;
      } catch (e) {
        if (attempt === 2) throw new Error(`${name}: ${e.message}`);
      }
    }
  };
  for (let i = 0; i < names.length; i += 8) await Promise.all(names.slice(i, i + 8).map(one));
  return out;
}

const current = exportsOf(args.current);
const legacy = exportsOf(args.legacy);
// Every package name either project has, plus the same short name in the other scope.
const searched = [...(await searchScope('midnight-ntwrk')), ...(await searchScope('midnightntwrk'))];
const short = new Set(
  [...Object.keys(current.versions), ...Object.keys(legacy.versions), ...searched].map((n) => n.split('/')[1]).concat(EXTRA_NAMES, NEVER_PUBLISHED_CANDIDATES),
);
const names = [...short].flatMap((s) => SCOPES.map((sc) => `${sc}/${s}`)).sort();
const packages = await registry(names);
// Names confirmed absent from the registry (404) at generation time.
const missing = names.filter((n) => NEVER_PUBLISHED_CANDIDATES.includes(n.split('/')[1]) && !packages[n]);

const index = {
  generated: new Date().toISOString().slice(0, 10),
  typescript: current.typescript,
  current: { versions: current.versions, modules: current.modules },
  legacy: { versions: legacy.versions, modules: legacy.modules },
  packages,
  missing,
};
fs.writeFileSync(outFile, JSON.stringify(index) + '\n');
const count = (m) => Object.values(m).reduce((a, v) => a + v.length, 0);
console.log(
  `${outFile}: current ${Object.keys(current.modules).length} modules / ${count(current.modules)} exports, ` +
    `legacy ${Object.keys(legacy.modules).length} / ${count(legacy.modules)}, ${Object.keys(packages).length} packages on npm, ${missing.length} names confirmed missing`,
);
