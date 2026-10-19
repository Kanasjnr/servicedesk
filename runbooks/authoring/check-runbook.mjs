#!/usr/bin/env node
/**
 * check-runbook.mjs: check one servicedesk runbook, in two parts.
 *
 * Structure, offline: front matter, required sections, the word budget, volatile values in the
 * action sections, and whether the README index and Error-string lookup point at the runbook.
 *
 * Facts, over the network: each row of the runbook's Key identifiers table names a public source
 * and the text that must be in it. This script fetches the source and reports whether the row
 * still holds. The runbook is the only list of its facts, so there is no second file to keep in
 * step. .github/workflows/runbook-facts.yml runs this part daily and opens an issue for each
 * source that stopped matching, so a machine notices a stale runbook before a reader does.
 *
 * A row in Key identifiers:
 *   | <fact> | `github:<owner>/<repo>/<path>` | `<text>` `<more text>` |   file on the default branch
 *   | <fact> | `npm:<package>/<path>`         | `<text>` |                 file in the `latest` release
 *   | <fact> | `issue:<owner>/<repo>#<n>`     | `open` |                   or `closed`
 * The text is matched exactly and cannot contain a backtick. Write a pipe as \|. A row whose
 * source cell has no such reference is left to the reader and is not tested.
 *
 * It reads public sources only. It writes nothing, signs nothing and needs no credentials. If
 * GITHUB_TOKEN or GH_TOKEN is set it is sent to api.github.com only, to raise the rate limit
 * (60 requests an hour without it).
 *
 * It can tell that a source no longer says what the runbook needs. It cannot tell whether the
 * runbook's reasoning from that source is right: that takes a reader who has not seen the issue.
 *
 * Requirements: Node >= 20. No npm install.
 *
 * Usage:
 *   node check-runbook.mjs <runbook-dir>                      # structure, then facts
 *   node check-runbook.mjs <runbook-dir> --offline            # structure only
 *   node check-runbook.mjs <runbook-dir> --print-readme-rows  # rows to paste into the README
 *   node check-runbook.mjs <runbook-dir> --readme <path>      # README defaults to <runbook-dir>/../README.md
 *   node check-runbook.mjs --all <runbooks-dir> --json        # facts only, every runbook with a facts table (CI)
 *
 * Each row ends in one of three states:
 *   holds    the source was read and has the text
 *   changed  the source was read and does not, or the source is gone (404)
 *   unknown  the source could not be read (network, rate limit, 5xx). Not a finding: run it again.
 *
 * Exit code: 0 = clean, 2 = a structure FAIL or a changed row, 1 = it could not run, or nothing
 * failed but a source could not be read.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const GITHUB_API = 'https://api.github.com';
const NPM_REGISTRY = 'https://registry.npmjs.org';
const FETCH_TIMEOUT_MS = 30_000;

// Budgets, in words. The runbook is read mid-incident and an agent pays for every word on every
// run. Words, not lines: an unwrapped file can pass a line budget while being longer than the
// file it replaced. These are judgment calls: 2,000 words is about ten minutes of careful reading.
const WARN_WORDS = 2000;
const FAIL_WORDS = 3000;
const ROOT_CAUSE_WARN_WORDS = 250;
// Same clock as .github/workflows/template-staleness.yml in the servicedesk repo.
const STALE_DAYS = 90;
const VERSION_WARN_DISTINCT = 6;
const DATE_WARN = 2;

const REQUIRED_KEYS = ['title', 'when_to_use', 'owner', 'compiled', 'last_reviewed', 'error_strings', 'review_when'];
// The spine is ordered: a reader recognises the problem, confirms it, fixes it, proves the fix,
// and knows when to stop.
const SPINE = ['Symptom', 'Root cause', 'Diagnose', 'Remediation', 'Confirm fixed', 'Stop and escalate'];
const REFERENCE_SECTIONS = ['Key identifiers', 'Reference material'];

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const die = (msg) => { console.error(`could not run: ${msg}`); process.exit(1); };

const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

// ---- reading a runbook -------------------------------------------------------------------

const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
const codeSpans = (cell) => [...(cell ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1]);

const parseSource = (ref) => {
  let m;
  if ((m = ref.match(/^github:([\w.-]+\/[\w.-]+)\/(.+)$/))) return { type: 'github', repo: m[1], path: m[2] };
  if ((m = ref.match(/^npm:((?:@[\w.-]+\/)?[\w.-]+)\/(.+)$/))) return { type: 'npm', package: m[1], path: m[2] };
  if ((m = ref.match(/^issue:([\w.-]+\/[\w.-]+)#(\d+)$/))) return { type: 'issue', repo: m[1], number: Number(m[2]) };
  return null;
};

// The Key identifiers table is the list of facts. `rows` are the ones a script can test,
// `unwatched` counts the rows left to the reader, `problems` are rows that cannot be parsed.
const parseFacts = (section) => {
  const out = { hasTable: false, rows: [], unwatched: 0, problems: [] };
  const table = (section?.text.split('\n') ?? []).filter((l) => /^\s*\|/.test(l));
  if (table.length === 0) return out;
  const header = splitRow(table[0]).map((c) => c.toLowerCase());
  const srcCol = header.findIndex((c) => c.includes('source'));
  const mustCol = header.findIndex((c) => c.includes('must contain'));
  if (srcCol < 0 || mustCol < 0) return out;
  out.hasTable = true;
  table.slice(1).filter((l) => !/^\s*\|\s*:?-{3,}/.test(l)).forEach((line, i) => {
    const cells = splitRow(line);
    const row = i + 1;
    const refs = codeSpans(cells[srcCol]).filter((s) => /^(github|npm|issue):/.test(s));
    if (refs.length === 0) { out.unwatched++; return; }
    if (refs.length > 1) { out.problems.push(`row ${row} names ${refs.length} sources. Use one row per source.`); return; }
    const source = parseSource(refs[0]);
    if (!source) { out.problems.push(`row ${row}: source \`${refs[0]}\` is not in a form the check reads`); return; }
    const expect = codeSpans(cells[mustCol]);
    if (expect.length === 0) { out.problems.push(`row ${row}: "Must contain" has no text in backticks`); return; }
    if (source.type === 'issue' && !(expect.length === 1 && ['open', 'closed'].includes(expect[0]))) { out.problems.push(`row ${row}: an issue row must contain \`open\` or \`closed\``); return; }
    out.rows.push({ row, fact: cells[0], ref: refs[0], source, expect });
  });
  return out;
};

const readRunbook = (dir) => {
  const name = path.basename(dir);
  const file = path.join(dir, `${name}.md`);
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const notes = [];

  const fm = {};
  let bodyStart = 0;
  let hasFrontMatter = false;
  if (lines[0]?.trim() === '---') {
    const end = lines.indexOf('---', 1);
    if (end < 0) die(`${file}: front matter opens with --- but never closes`);
    hasFrontMatter = true;
    bodyStart = end + 1;
    let key = null;
    const unquote = (s) => s.trim().replace(/^(["'])(.*)\1$/, '$2');
    for (const raw of lines.slice(1, end)) {
      if (!raw.trim() || raw.trim().startsWith('#')) continue;
      const item = raw.match(/^\s+-\s+(.*)$/);
      if (item && key) { (fm[key] ||= []).push(unquote(item[1])); continue; }
      const kv = raw.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (!kv) { notes.push(`front matter line not understood: "${raw.trim()}"`); continue; }
      key = kv[1];
      const v = kv[2].trim();
      fm[key] = v === '' || v === '[]' ? [] : unquote(v);
    }
  }

  // Sections are found outside code fences, so a `## ` inside a sample does not count.
  const body = lines.slice(bodyStart);
  const sections = [];
  let inFence = false;
  body.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
    if (inFence) return;
    const h = l.match(/^## (.+?)\s*$/);
    if (h) sections.push({ title: h[1], start: i });
  });
  sections.forEach((s, i) => { s.end = i + 1 < sections.length ? sections[i + 1].start : body.length; s.text = body.slice(s.start + 1, s.end).join('\n'); });
  const find = (prefix) => sections.find((s) => s.title.toLowerCase().startsWith(prefix.toLowerCase()));

  return { dir, name, file, fm, hasFrontMatter, notes, bodyText: body.join('\n'), sections, find, facts: parseFacts(find('Key identifiers')) };
};

// ---- structure ---------------------------------------------------------------------------

const countWords = (t) => (t.match(/\S+/g) || []).length;

const checkStructure = (rb, readmePath) => {
  const findings = [];
  const fail = (msg, fix) => findings.push({ level: 'FAIL', msg, fix });
  const warn = (msg, fix) => findings.push({ level: 'WARN', msg, fix });
  const { fm, find, bodyText, sections, facts } = rb;

  for (const n of rb.notes) warn(n, 'Use `key: "value"` or a `- "item"` list.');
  if (!rb.hasFrontMatter) fail('no front matter', 'Start the file with a --- block. Copy it from authoring/runbook-template.md.');
  else for (const k of REQUIRED_KEYS) if (!(k in fm)) fail(`front matter is missing \`${k}\``, 'See authoring/runbook-template.md for what each key is for.');

  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
  for (const k of ['compiled', 'last_reviewed']) if (k in fm && !isDate(fm[k])) fail(`\`${k}\` is not a YYYY-MM-DD date`, 'Use an absolute date.');
  if (isDate(fm.compiled) && isDate(fm.last_reviewed)) {
    if (fm.last_reviewed < fm.compiled) fail('`last_reviewed` is before `compiled`', 'last_reviewed is the last day a person re-read the runbook against its sources.');
    const age = (Date.now() - Date.parse(fm.last_reviewed)) / 864e5;
    if (age < -1) fail('`last_reviewed` is in the future', 'Use the day the review was actually done.');
    if (age > STALE_DAYS) warn(`last reviewed ${Math.floor(age)} days ago`, 'Run this check, re-read the steps, and give the file to a fresh reader.');
  }
  const errorStrings = Array.isArray(fm.error_strings) ? fm.error_strings : [];
  const reviewWhen = Array.isArray(fm.review_when) ? fm.review_when : [];
  if ('error_strings' in fm && errorStrings.length === 0) warn('`error_strings` is empty', 'List the exact text a user would paste. Triage greps for it. Leave empty only when the problem has no message.');
  if ('review_when' in fm && reviewWhen.length === 0) fail('`review_when` is empty', 'Name at least one event no Key identifiers row can see that would make this runbook wrong.');

  let lastIndex = -1;
  for (const want of SPINE) {
    const s = find(want);
    if (!s) { fail(`missing section \`## ${want}\``, 'Every runbook has the same sections in the same order, so a reader knows where to look.'); continue; }
    const idx = sections.indexOf(s);
    if (idx < lastIndex) fail(`section \`## ${want}\` is out of order`, `Order: ${SPINE.join(' → ')}.`);
    lastIndex = Math.max(lastIndex, idx);
  }
  for (const want of REFERENCE_SECTIONS) if (!find(want)) fail(`missing section \`## ${want}\``, 'The facts with their sources, and the links a reader needs.');
  if (!/not this runbook/i.test(bodyText)) fail('no "Not this runbook" list', 'Name the look-alike problems and link where they go. Symptoms overlap.');

  const listItems = (s) => (s?.text.match(/^\s*(?:[-*]|\d+\.)\s+\S/gm) || []).length;
  if (find('Confirm fixed') && listItems(find('Confirm fixed')) === 0) fail('`Confirm fixed` lists nothing to observe', 'Say what the reader must see before calling it fixed.');
  if (find('Stop and escalate') && listItems(find('Stop and escalate')) === 0) fail('`Stop and escalate` lists no condition', 'Say when to stop following this runbook and what to hand over.');
  const rem = find('Remediation');
  if (rem && !/trade-?off/i.test(rem.text)) warn('no remediation states a trade-off', 'Each option costs something. Say what, so the reader can choose.');
  for (const s of errorStrings) if (!bodyText.includes(s)) fail(`error string not found in the runbook body: "${s}"`, 'error_strings must be exact substrings of text the runbook shows under Symptom.');

  // The facts table. A fact with no row is a guess the next reader inherits.
  const ids = find('Key identifiers');
  if (ids && !facts.hasTable) fail('`Key identifiers` has no table with "Source of truth" and "Must contain" columns', 'List every fact the runbook relies on with a source and the text that must be in it. See the header of this script for the row forms.');
  for (const p of facts.problems) fail(`Key identifiers ${p}`, 'See the header of this script for the row forms.');
  if (facts.hasTable && facts.rows.length === 0) warn('no Key identifiers row can be tested by a script', 'Nothing will notice when a fact changes. Give at least one row a `github:`, `npm:` or `issue:` source.');
  else if (facts.unwatched) warn(`${facts.unwatched} Key identifiers row(s) have no source a script can read`, 'Only a reader will notice when they change. Leave them if the source needs a login or a token.');

  const bodyWords = countWords(bodyText);
  if (bodyWords > FAIL_WORDS) fail(`${bodyWords} words after front matter (limit ${FAIL_WORDS})`, 'Keep only what the reader acts on. Link what someone else maintains, and leave the investigation to git history.');
  else if (bodyWords > WARN_WORDS) warn(`${bodyWords} words after front matter (target ${WARN_WORDS})`, 'Check each paragraph: does the reader act on it mid-incident? If not, cut it.');
  const rc = find('Root cause');
  if (rc && countWords(rc.text) > ROOT_CAUSE_WARN_WORDS) warn(`Root cause runs ${countWords(rc.text)} words (target ${ROOT_CAUSE_WARN_WORDS})`, 'State the mechanism in a few sentences, enough to confirm the match.');

  // Volatile values in the action sections go false silently. They belong in a Key identifiers
  // row, where a script reads them, or nowhere.
  const actionText = sections.filter((s) => s !== ids && !s.title.toLowerCase().startsWith('reference material')).map((s) => s.text).join('\n');
  const shas = actionText.match(/\b[0-9a-f]{40}\b/g) || [];
  if (shas.length) warn(`${shas.length} full commit hash(es) outside Key identifiers and Reference material`, 'A pinned commit is history. Link it from Reference material or drop it.');
  const lineRefs = actionText.match(/\b(?:L\d+(?:[-–]L?\d+)?|lines?\s+~?\d+(?:[-–]\d+)?)\b/g) || [];
  if (lineRefs.length) warn(`${lineRefs.length} source line reference(s) outside Key identifiers`, 'Line numbers move with every commit. Name the function instead.');
  const versions = [...new Set(actionText.match(/\b\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?\b/g) || [])];
  if (versions.length > VERSION_WARN_DISTINCT) warn(`${versions.length} distinct version numbers in the action sections`, 'Give the command that prints the current version instead of the version.');
  const dates = actionText.match(/\b20\d{2}-\d{2}-\d{2}\b/g) || [];
  if (dates.length > DATE_WARN) warn(`${dates.length} dates in the action sections`, 'A date usually marks a statement about the world. Rewrite it as a condition the reader can observe.');
  if (/project_id=[A-Za-z0-9]{12,}/.test(bodyText)) fail('something that looks like a real project token is in the file', 'Replace it with <token> or an environment variable, and rotate the token.');

  for (const m of fs.readFileSync(rb.file, 'utf8').matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^(?:[a-z]+:|#|<)/i.test(target)) continue;
    if (!fs.existsSync(path.resolve(rb.dir, decodeURIComponent(target.split('#')[0])))) fail(`broken relative link: ${target}`, 'Fix the path, or remove the link if the target is gone.');
  }

  const rel = `${rb.name}/${rb.name}.md`;
  const title = typeof fm.title === 'string' ? fm.title : rb.name;
  const cell = (s) => String(s).replace(/\|/g, '\\|');
  if (flag('print-readme-rows')) {
    console.log('Index row:\n');
    console.log(`| [${cell(title)}](${rel}) | ${cell(fm.when_to_use ?? '')} |`);
    console.log('\nError-string lookup rows:\n');
    for (const s of errorStrings) console.log(`| \`${cell(s)}\` | [${cell(title)}](${rel}) |`);
    console.log('');
  }
  if (!fs.existsSync(readmePath)) warn(`no README at ${readmePath}`, 'Pass --readme, or the index and lookup checks are skipped.');
  else {
    const readme = fs.readFileSync(readmePath, 'utf8');
    if (!readme.includes(`(${rel})`)) fail('the README index has no row for this runbook', 'Run with --print-readme-rows and paste the Index row. An unlisted runbook is never found.');
    if (!/^## Error-string lookup/m.test(readme)) fail('the README has no `## Error-string lookup` section', 'Triage greps that table first. This is a defect in the shared README, not in this runbook: restore the section from the README\'s history as its own change, then add this runbook\'s rows.');
    else for (const s of errorStrings) if (!readme.includes(s)) fail(`the README lookup is missing: "${s}"`, 'Run with --print-readme-rows and paste the lookup rows.');
  }

  return { findings, bodyWords, errorStrings: errorStrings.length };
};

// ---- sources -----------------------------------------------------------------------------
// Each reader returns { status: 'ok', text } | { status: 'gone', why } | { status: 'unknown', why }.
// 'gone' means the source answered and the thing is not there. Anything else that stops us from
// reading it is 'unknown', so a network blip never opens an issue.

const get = async (url, headers = {}) => {
  try {
    return await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    return { failed: true, why: `${e.name}: ${e.message}` };
  }
};

const githubHeaders = (accept) => ({
  Accept: accept,
  'User-Agent': 'servicedesk-check-runbook',
  'X-GitHub-Api-Version': '2022-11-28',
  ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
});

const classify = (res, what) => {
  if (res.failed) return { status: 'unknown', why: `${what}: ${res.why}` };
  if (res.status === 404 || res.status === 410) return { status: 'gone', why: `${what}: HTTP ${res.status}` };
  if (!res.ok) return { status: 'unknown', why: `${what}: HTTP ${res.status}` };
  return null;
};

const cache = new Map();
const cached = (key, fn) => { if (!cache.has(key)) cache.set(key, fn()); return cache.get(key); };

const readGithubFile = ({ repo, path: p }) => cached(`github:${repo}/${p}`, async () => {
  const res = await get(`${GITHUB_API}/repos/${repo}/contents/${p.split('/').map(encodeURIComponent).join('/')}`, githubHeaders('application/vnd.github.raw+json'));
  return classify(res, `${repo}/${p}`) ?? { status: 'ok', text: await res.text() };
});

const readGithubIssue = ({ repo, number }) => cached(`issue:${repo}#${number}`, async () => {
  const res = await get(`${GITHUB_API}/repos/${repo}/issues/${number}`, githubHeaders('application/vnd.github+json'));
  return classify(res, `${repo}#${number}`) ?? { status: 'ok', text: (await res.json()).state };
});

// A tar archive is a run of 512-byte headers, each followed by the file's bytes padded to 512.
// npm tarballs are small and plain, so this reads them without a dependency. Long paths arrive
// as a pax ('x') or GNU ('L') record that names the entry after it.
const untar = (buf) => {
  const files = new Map();
  const str = (b) => { const end = b.indexOf(0); return b.subarray(0, end < 0 ? b.length : end).toString('utf8'); };
  let longName = null;
  for (let off = 0; off + 512 <= buf.length;) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const size = parseInt(str(h.subarray(124, 136)).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const data = buf.subarray(off + 512, off + 512 + size);
    const prefix = str(h.subarray(345, 500));
    const name = longName ?? (prefix ? `${prefix}/${str(h.subarray(0, 100))}` : str(h.subarray(0, 100)));
    longName = null;
    if (type === 'L') longName = str(data);
    else if (type === 'x') { const m = data.toString('utf8').match(/\d+ path=([^\n]*)\n/); if (m) longName = m[1]; }
    else if (type === '0') files.set(name, data);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
};

const readNpmPackage = (pkg) => cached(`npm:${pkg}`, async () => {
  const meta = await get(`${NPM_REGISTRY}/${pkg.replace('/', '%2F')}/latest`, { Accept: 'application/json' });
  const bad = classify(meta, `${pkg}@latest`);
  if (bad) return bad;
  const manifest = await meta.json();
  const tarball = manifest?.dist?.tarball;
  if (!tarball || !tarball.startsWith(`${NPM_REGISTRY}/`)) return { status: 'unknown', why: `${pkg}@latest: registry gave no tarball on ${NPM_REGISTRY}` };
  const res = await get(tarball);
  const badTar = classify(res, `${pkg}@${manifest.version} tarball`);
  if (badTar) return badTar;
  try {
    return { status: 'ok', version: manifest.version, files: untar(zlib.gunzipSync(Buffer.from(await res.arrayBuffer()))) };
  } catch (e) {
    return { status: 'unknown', why: `${pkg}@${manifest.version}: could not unpack (${e.message})` };
  }
});

const readNpmFile = async ({ package: pkg, path: p }) => {
  const got = await readNpmPackage(pkg);
  if (got.status !== 'ok') return got;
  const data = got.files.get(`package/${p}`);
  if (!data) return { status: 'gone', why: `${pkg}@${got.version} has no ${p}` };
  return { status: 'ok', text: data.toString('utf8'), version: got.version };
};

const READERS = { github: readGithubFile, issue: readGithubIssue, npm: readNpmFile };

const sourceUrl = (s) => s.type === 'github' ? `https://github.com/${s.repo}/blob/HEAD/${s.path}`
  : s.type === 'issue' ? `https://github.com/${s.repo}/issues/${s.number}`
  : `https://www.npmjs.com/package/${s.package}?activeTab=code`;

// ---- facts -------------------------------------------------------------------------------

const checkRow = async (r) => {
  const got = await READERS[r.source.type](r.source);
  const base = { row: r.row, fact: r.fact, source: r.ref, url: sourceUrl(r.source), ...(got.version ? { version: got.version } : {}) };
  if (got.status === 'unknown') return { ...base, status: 'unknown', detail: got.why };
  if (got.status === 'gone') return { ...base, status: 'changed', detail: `the source is gone (${got.why})` };
  if (r.source.type === 'issue') {
    return got.text === r.expect[0] ? { ...base, status: 'holds' } : { ...base, status: 'changed', detail: `expected the issue to be ${r.expect[0]}, it is ${got.text}` };
  }
  const missing = r.expect.filter((s) => !got.text.includes(s));
  return missing.length ? { ...base, status: 'changed', detail: `no longer found: ${missing.map((s) => JSON.stringify(s)).join('; ')}` } : { ...base, status: 'holds' };
};

const checkFacts = async (rb) => {
  const results = [];
  for (const r of rb.facts.rows) results.push(await checkRow(r));
  return { runbook: rb.name, results };
};

const summarise = (reports) => {
  const all = reports.flatMap((r) => r.results);
  const count = (s) => all.filter((r) => r.status === s).length;
  return { holds: count('holds'), changed: count('changed'), unknown: count('unknown') };
};

const printFacts = (report) => {
  for (const r of report.results) {
    console.log(`${r.status.padEnd(8)}row ${String(r.row).padEnd(3)}${r.source}${r.version ? ` (read ${r.version})` : ''}`);
    if (r.detail) console.log(`           ${r.detail}\n           fact: ${r.fact}`);
  }
};

// ---- main --------------------------------------------------------------------------------

const allDir = opt('all');
const dirArg = args.find((a, i) => !a.startsWith('--') && !['--all', '--readme'].includes(args[i - 1]));
if (!allDir && !dirArg) die('usage: node check-runbook.mjs <runbook-dir> [--offline] [--print-readme-rows] [--readme <path>] | --all <runbooks-dir> [--json]');

if (allDir) {
  const root = path.resolve(allDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) die(`${root} is not a directory`);
  // Runbooks written before this format have no facts table. They are skipped, not failed.
  const runbooks = fs.readdirSync(root).sort().map((d) => path.join(root, d)).filter((d) => fs.statSync(d).isDirectory()).map(readRunbook).filter((rb) => rb?.facts.rows.length);
  const reports = [];
  for (const rb of runbooks) reports.push(await checkFacts(rb));
  const summary = summarise(reports);
  if (flag('json')) console.log(JSON.stringify({ checked_at: new Date().toISOString(), summary, runbooks: reports }, null, 2));
  else {
    for (const r of reports) { console.log(`${r.runbook}\n`); printFacts(r); console.log(''); }
    console.log(`RESULT: ${reports.length} runbook(s), ${summary.holds} hold, ${summary.changed} changed, ${summary.unknown} unknown.`);
  }
  process.exit(summary.changed ? 2 : summary.unknown ? 1 : 0);
}

const dir = path.resolve(dirArg);
if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) die(`${dir} is not a directory`);
const rb = readRunbook(dir);
if (!rb) die(`expected the runbook at ${path.join(dir, `${path.basename(dir)}.md`)} (the file takes the directory's name)`);

const structure = checkStructure(rb, path.resolve(opt('readme') ?? path.join(dir, '..', 'README.md')));
const fails = structure.findings.filter((f) => f.level === 'FAIL');
const warns = structure.findings.filter((f) => f.level === 'WARN');
console.log(`${rb.name}: ${structure.bodyWords} words after front matter, ${rb.sections.length} sections, ${structure.errorStrings} error strings, ${rb.facts.rows.length} facts a script can test`);
for (const f of [...fails, ...warns]) console.log(`\n${f.level}  ${f.msg}\n      ${f.fix}`);
console.log(`\nSTRUCTURE: ${fails.length} fail, ${warns.length} warn.`);

let summary = { holds: 0, changed: 0, unknown: 0 };
if (flag('offline')) console.log('FACTS: skipped (--offline).');
else {
  const report = await checkFacts(rb);
  summary = summarise([report]);
  console.log('');
  printFacts(report);
  console.log(`\nFACTS: ${summary.holds} hold, ${summary.changed} changed, ${summary.unknown} unknown.${summary.changed ? '' : summary.unknown ? ' Nothing changed, but not everything could be read: run it again.' : ''}`);
}
console.log('\nThis says nothing about whether the steps make sense. That takes a reader who has not seen the issue.');
process.exit(fails.length || summary.changed ? 2 : summary.unknown ? 1 : 0);
