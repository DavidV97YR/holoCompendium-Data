#!/usr/bin/env node
/**
 * fix-chat-permanent.js  —  ONE-OFF REPAIR, delete after running
 *
 * A short-lived version of fetch-chat.js classified YouTube's
 * "status":"LOGIN_REQUIRED" / "UNPLAYABLE" responses as permanent and wrote
 * entries with no attempt counter:
 *
 *   "<videoId>": { "e": "private" }     ← never retried again
 *   "<videoId>": { "e": "gone" }
 *
 * That was wrong. YouTube serves datacenter IPs a "sign in to confirm you're
 * not a bot" page carrying identical markup to a genuine members-only video,
 * so from CI the two are indistinguishable. In one run it mislabelled 13 public
 * streams — including one that extracts fine (¥10,320) from a normal IP.
 *
 * This removes those entries entirely so the streams look unprocessed and get
 * walked again on the next run.
 *
 * Usage:   node scripts/fix-chat-permanent.js [--apply]
 *          (dry run by default — prints what it would change and touches nothing)
 */

const fs   = require('fs');
const path = require('path');

const APPLY   = process.argv.includes('--apply');
const DATA    = process.env.DATA_DIR || './data';

function findChatFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const branch of fs.readdirSync(dir)) {
    const bp = path.join(dir, branch);
    if (!fs.statSync(bp).isDirectory()) continue;
    for (const f of fs.readdirSync(bp)) {
      if (f.endsWith('-chat.json')) out.push(path.join(bp, f));
    }
  }
  return out;
}

const files = findChatFiles(DATA);
if (!files.length) {
  console.error('No *-chat.json files found under ' + DATA);
  process.exit(1);
}

console.log(APPLY ? '\nAPPLYING repair\n' : '\nDRY RUN — nothing will be written (pass --apply to commit)\n');

let totalFixed = 0, filesTouched = 0;

for (const file of files) {
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    console.error('  ✗ could not parse ' + file);
    continue;
  }
  const streams = j.streams || {};

  // The signature: an error entry with no attempt counter.
  const bad = Object.keys(streams).filter(id => {
    const v = streams[id];
    return v && typeof v === 'object' && v.e && v.n === undefined;
  });
  if (!bad.length) continue;

  filesTouched++;
  totalFixed += bad.length;
  const kinds = {};
  bad.forEach(id => { const k = streams[id].e; kinds[k] = (kinds[k] || 0) + 1; });
  console.log('  ' + path.basename(file).padEnd(34)
            + String(bad.length).padStart(4) + ' entries  '
            + Object.entries(kinds).map(([k, n]) => k + '=' + n).join(' '));

  if (APPLY) {
    bad.forEach(id => { delete streams[id]; });
    j.streams = streams;
    fs.writeFileSync(file, JSON.stringify(j, null, 2), 'utf8');
  }
}

console.log('\n  files affected : ' + filesTouched);
console.log('  entries ' + (APPLY ? 'removed  : ' : 'to remove: ') + totalFixed);
if (!APPLY && totalFixed) console.log('\n  re-run with --apply to write the changes.');
if (APPLY && totalFixed)  console.log('\n  those streams will be walked again on the next run.');
console.log('');
