#!/usr/bin/env node
/**
 * test-check-sdk.mjs: re-run check-sdk.mjs against its recorded cases.
 *
 * 1. The AI corpus (cases/haiku, cases/sonnet, cases/opus): the lines check-sdk.mjs flags in each file
 *    must match cases/expected.json `checker_lines`.
 * 2. cases/right-forms.ts, the form the checker recommends for each mistake: no findings.
 * 3. cases/explain.json: each real error text gets the expected explanation and exit code.
 * 4. A NodeNext project that uses the DApp connector: flagged with 4.0.1 installed (its index.d.ts imports
 *    without extensions), not flagged with a fixed build installed (`.js` imports, midnight-dapp-connector-api#61),
 *    flagged with the status note when nothing is installed. Built in a temporary directory, removed afterwards.
 *
 * With --tsc <dir>, where <dir> has the network set and typescript installed (see check-sdk.NOTES.md),
 * it also re-checks the ground truth: compiles cases/contract/counter.compact with Compact 0.31.1, runs
 * tsc on each corpus file and compares the errors with expected.json `tsc` (NodeNext) and, for the browser
 * files, `tsc_bundler` (bundler resolution, as Vite resolves them), and typechecks right-forms.ts under
 * bundler resolution (0 errors). The `compact` CLI must be installed; its default is not changed.
 *
 * Usage: node test-check-sdk.mjs [--tsc <dir>]
 * Needs Node >= 20. Without --tsc nothing is installed or sent; with it, a temporary copy of cases/ is
 * written inside <dir> and removed afterwards.
 * Exit code: 0 = all pass, 1 = a case failed or could not run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CASES = path.join(HERE, 'cases');
const CHECKER = path.join(HERE, 'check-sdk.mjs');
const MODELS = ['haiku', 'sonnet', 'opus'];

const argv = process.argv.slice(2);
const tscDir = argv[0] === '--tsc' ? argv[1] : undefined;
if ((argv.length && !tscDir) || argv.length > 2) {
  console.error('usage: node test-check-sdk.mjs [--tsc <dir with the network set and typescript installed>]');
  process.exit(1);
}

const expected = JSON.parse(fs.readFileSync(path.join(CASES, 'expected.json'), 'utf8'));
const { cases: explainCases } = JSON.parse(fs.readFileSync(path.join(CASES, 'explain.json'), 'utf8'));
let failed = 0;
const fail = (what, detail) => {
  failed++;
  console.log(`FAIL ${what}\n     ${detail}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const checker = (args) => spawnSync(process.execPath, [CHECKER, ...args], { cwd: CASES, encoding: 'utf8' });

// ---------- 1. corpus: flagged lines per file ----------
let corpusLines = 0;
for (const [file, rec] of Object.entries(expected.files)) {
  const r = checker([file]);
  const lines = [...new Set(r.stdout.split('\n').filter((l) => l.startsWith(`${file}:`)).map((l) => Number(l.split(':')[1])))].sort((a, b) => a - b);
  const want = [...rec.checker_lines].sort((a, b) => a - b);
  corpusLines += lines.length;
  if (!same(lines, want)) fail(`corpus ${file}`, `flagged lines ${JSON.stringify(lines)}, expected ${JSON.stringify(want)}`);
  else if (r.status !== (want.length ? 2 : 0)) fail(`corpus ${file}`, `exit ${r.status}`);
}
const corpusFiles = MODELS.flatMap((m) => fs.readdirSync(path.join(CASES, m)).map((f) => `${m}/${f}`));
for (const f of corpusFiles) if (!expected.files[f]) fail(`corpus ${f}`, 'not recorded in expected.json');
console.log(`corpus: ${Object.keys(expected.files).length} files, ${corpusLines} flagged lines checked`);

// ---------- 2. the recommended forms: no findings ----------
{
  const r = checker(['right-forms.ts']);
  if (r.status !== 0) fail('right-forms.ts', `exit ${r.status}: ${r.stdout.trim().split('\n')[0]}`);
  else console.log('right-forms.ts: no findings');
}

// ---------- 3. --explain ----------
let explained = 0;
for (const c of explainCases) {
  const r = checker(['--explain', c.text]);
  if (r.status !== c.exit || !r.stdout.includes(c.expect)) fail(`explain (${c.source})`, `exit ${r.status}, wanted ${c.exit} and "${c.expect}"; got: ${r.stdout.trim().slice(0, 200)}`);
  else explained++;
}
console.log(`explain: ${explained} of ${explainCases.length} cases`);

// ---------- 4. the DApp connector under NodeNext, by what's installed ----------
{
  // The first lines of dist/index.d.ts in 4.0.1 and in the canary that has the fix.
  const BROKEN = "import './globals';\nexport type { InitialAPI, ConnectedAPI } from './api';\nexport { ErrorCodes } from './errors';\n";
  const FIXED = "export * from './globals.js';\nexport type { InitialAPI, ConnectedAPI } from './api.js';\nexport { ErrorCodes } from './errors.js';\n";
  const setups = [
    { name: '4.0.1 installed', version: '4.0.1', dts: BROKEN, expect: 'Installed: dapp-connector-api 4.0.1' },
    { name: 'fixed canary installed', version: '4.1.0-canary.20260819082604-3b622cb', dts: FIXED, expect: null },
    { name: 'nothing installed', version: '4.0.1', dts: null, expect: 'midnight-dapp-connector-api#61' },
  ];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-sdk-connector-'));
  try {
    for (const t of setups) {
      const dir = path.join(tmp, t.name.replace(/\W+/g, '-'));
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module', dependencies: { '@midnight-ntwrk/dapp-connector-api': t.version } }));
      fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true } }));
      fs.writeFileSync(path.join(dir, 'app.ts'), "import type { InitialAPI } from '@midnight-ntwrk/dapp-connector-api';\nexport type W = InitialAPI;\n");
      if (t.dts) {
        const pkg = path.join(dir, 'node_modules', '@midnight-ntwrk', 'dapp-connector-api');
        fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@midnight-ntwrk/dapp-connector-api', version: t.version }));
        fs.writeFileSync(path.join(pkg, 'dist', 'index.d.ts'), t.dts);
      }
      const r = spawnSync(process.execPath, [CHECKER, dir], { encoding: 'utf8' });
      const ok = t.expect ? r.status === 2 && r.stdout.includes(t.expect) : r.status === 0;
      if (!ok) fail(`connector (${t.name})`, `exit ${r.status}: ${r.stdout.trim().slice(0, 200)}`);
    }
    console.log(`connector under NodeNext: ${setups.length} setups`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- 5. optional: the ground truth, with tsc and the compiler ----------
if (tscDir) {
  const dir = path.resolve(tscDir);
  let tsc;
  try {
    tsc = path.join(path.dirname(createRequire(path.join(dir, 'package.json')).resolve('typescript/package.json')), 'bin', 'tsc');
  } catch {
    tsc = '';
  }
  if (!fs.existsSync(tsc)) {
    console.error(`no typescript in ${dir}/node_modules`);
    process.exit(1);
  }
  const work = fs.mkdtempSync(path.join(dir, '.check-sdk-test-'));
  try {
    fs.cpSync(CASES, work, { recursive: true });
    fs.writeFileSync(path.join(work, 'package.json'), '{"type":"module"}\n');
    // The models import the compiled contract both as ../contract/… and ./contract/…; the recording had both resolve.
    for (const m of MODELS) fs.symlinkSync('../contract', path.join(work, m, 'contract'));
    const c = spawnSync('compact', ['compile', '+0.31.1', '--skip-zk', 'contract/counter.compact', 'contract/out'], { cwd: work, encoding: 'utf8' });
    if (c.status !== 0) {
      console.error(`compact compile +0.31.1 failed (is the compact CLI installed, with 0.31.1?):\n${c.stdout}${c.stderr}`);
      process.exit(1);
    }
    const base = {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', jsx: 'react-jsx', strict: false, noImplicitAny: false,
      skipLibCheck: true, esModuleInterop: true, allowJs: false, noEmit: true, types: ['node'],
    };
    const runTsc = (name, compilerOptions, include) => {
      fs.writeFileSync(path.join(work, name), JSON.stringify({ compilerOptions, include }));
      const r = spawnSync(process.execPath, [tsc, '-p', name, '--pretty', 'false'], { cwd: work, encoding: 'utf8' });
      return r.stdout
        .split('\n')
        .map((l) => l.match(/^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/))
        .filter(Boolean)
        .map(([, , line, code, message]) => ({ line: Number(line), code, message }));
    };
    const bundler = { ...base, lib: ['ES2022', 'DOM'], module: 'ESNext', moduleResolution: 'bundler' };
    const compare = (what, got, want) => {
      if (same(got, want)) return;
      const key = (e) => `${e.line} ${e.code} ${e.message}`;
      const gotK = new Set(got.map(key));
      const wantK = new Set(want.map(key));
      fail(what, `new: ${JSON.stringify([...gotK].filter((k) => !wantK.has(k)))}; no longer reported: ${JSON.stringify([...wantK].filter((k) => !gotK.has(k)))}`);
    };
    let tscErrors = 0;
    for (const [file, rec] of Object.entries(expected.files)) {
      const got = runTsc('tsconfig.one.json', base, [file]);
      tscErrors += got.length;
      compare(`tsc ${file}`, got, rec.tsc);
      if (rec.tsc_bundler) {
        const gotB = runTsc('tsconfig.one.json', bundler, [file]);
        tscErrors += gotB.length;
        compare(`tsc (bundler) ${file}`, gotB, rec.tsc_bundler);
      }
    }
    console.log(`tsc: ${Object.keys(expected.files).length} files, ${tscErrors} errors compared (recorded ${expected.against})`);
    const right = runTsc('tsconfig.right.json', bundler, ['right-forms.ts']);
    if (right.length) fail('tsc right-forms.ts (bundler)', JSON.stringify(right));
    else console.log('tsc right-forms.ts: 0 errors (moduleResolution bundler)');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

console.log(failed ? `\n${failed} failure(s)` : '\nall pass');
process.exit(failed ? 1 : 0);
