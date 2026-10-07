#!/usr/bin/env node
/**
 * gen-tables.mjs: rebuild decode-1010.mjs's code tables from midnight-node source.
 *
 * Reads a midnight-node `types.rs` (the file with `impl From<LedgerApiError> for u8`) and prints
 * the code → variant table and the Display-text → code map as JavaScript, in the layout
 * decode-1010.mjs embeds. Paste the output over the matching consts there when a node release
 * changes its codes, and re-run the checks in decode-1010.NOTES.md.
 *
 *   gh api 'repos/midnightntwrk/midnight-node/contents/ledger/src/versions/common/types.rs?ref=node-1.0.400' \
 *     -q .content | base64 -d > types-1.0.rs
 *   node gen-tables.mjs types-1.0.rs NODE_1_0 DISPLAY_1_0
 *
 * Node >= 20, no install, no network. Exit 1 if the impl can't be found or a line can't be parsed.
 */

import fs from 'node:fs';

const [file, tableName = 'NODE_TABLE', displayName = 'DISPLAY_TABLE'] = process.argv.slice(2);
if (!file) {
  console.error('usage: node gen-tables.mjs <types.rs> [TABLE_CONST] [DISPLAY_CONST]');
  process.exit(1);
}
const src = fs.readFileSync(file, 'utf8');
const body = (re) => {
  const m = src.match(re);
  if (!m) {
    console.error(`${file}: ${re} not found`);
    process.exit(1);
  }
  return m[1].split('\n');
};

// `impl From<LedgerApiError> for u8`: nested `X(e) => match e {` blocks, leaves `Y => N,`.
const codes = new Map();
const stack = [];
for (const raw of body(/impl From<LedgerApiError> for u8 \{([\s\S]*?)\n\}/)) {
  const line = raw.split('//')[0].trim();
  if (!line) continue;
  const open = line.match(/^([\w:]+)\((\w+)\)\s*=>\s*match\s+\w+\s*\{/);
  if (open) {
    stack.push(open[1].split('::').at(-1));
    continue;
  }
  const leaf = line.match(/^([\w:]+)(?:\s*\{\s*\.\.\s*\}|\([^)]*\))?\s*=>\s*(\d+)\s*,?$/);
  if (leaf) {
    const path = [...stack, leaf[1].split('::').at(-1)].join('.');
    const code = Number(leaf[2]);
    if (codes.has(code)) {
      console.error(`duplicate code ${code}: ${codes.get(code)} / ${path}`);
      process.exit(1);
    }
    codes.set(code, path);
    continue;
  }
  if (line.startsWith('}')) {
    stack.pop();
    continue;
  }
  if (line.includes('=>') || line === 'match value {' || line.startsWith('fn ')) {
    if (line.includes('=>')) {
      console.error(`unparsed: ${line}`);
      process.exit(1);
    }
    continue;
  }
}

// `impl core::fmt::Display for LedgerApiError`: the text for each non-Transaction arm.
const byPath = new Map([...codes].map(([c, p]) => [p, c]));
const display = new Map();
let cat;
let ident;
for (const raw of body(/impl core::fmt::Display for LedgerApiError \{([\s\S]*?)\n\}/)) {
  const line = raw.trim();
  const c = line.match(/^LedgerApiError::(Deserialization|Serialization|Transaction)\(\w+\)\s*=>\s*match/);
  if (c) {
    cat = c[1];
    continue;
  }
  const arm = line.match(/^([\w:]+)\s*=>/);
  if (arm) {
    ident = arm[1].split('::').at(-1);
    if (arm[1].startsWith('LedgerApiError::')) cat = undefined;
  }
  const w = line.match(/write!\(f,\s*"([^"{]*)"\)/);
  if (w && ident && cat !== 'Transaction') {
    const path = cat ? `${cat}.${ident}` : ident;
    if (!byPath.has(path)) {
      console.error(`no code for Display arm ${path}`);
      process.exit(1);
    }
    display.set(w[1], byPath.get(path));
  }
}

// Same layout as decode-1010.mjs: names without the leading `Transaction.`, wrapped at 100.
const items = [...codes].sort((a, b) => a[0] - b[0]).map(([c, p]) => `${c}: '${p.replace(/^Transaction\./, '')}'`);
const lines = [];
let cur = '  ';
for (const it of items) {
  const piece = `${it}, `;
  if (cur.length + piece.length > 100) {
    lines.push(cur.trimEnd());
    cur = '  ';
  }
  cur += piece;
}
lines.push(cur.trimEnd().replace(/,$/, ''));
console.log(`const ${tableName} = {\n${lines.join('\n')}\n};`);
const disp = [...display].sort((a, b) => a[1] - b[1]).map(([t, c]) => `  ${JSON.stringify(t)}: ${c},`);
console.log(`const ${displayName} = {\n${disp.join('\n')}\n};`);
console.error(`${codes.size} codes, ${display.size} display texts`);
