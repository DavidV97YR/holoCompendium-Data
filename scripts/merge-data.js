'use strict';

// ── Merge a job's data commit onto a newer main, by content ─────────────────
// Every data job commits, pushes, and on a rejected push used to replay its
// commit with `git pull --rebase -X ours|theirs`. That merges JSON as lines of
// text, and a talent file's videos are a sorted list: when a job moved a video
// (its date changed, so it re-sorted) while another job inserted one nearby,
// the insert half of the move collided and was dropped as a "conflict" while
// the delete half applied cleanly — and the video vanished. Mizumiya Su's
// 2-hour stream of 2026-09-25 went that way, twice in two days.
//
// This merges by meaning instead. For each file the job changed it reads three
// versions — base (what the job checked out), ours (what the job wrote) and
// theirs (main now) — and merges them:
//  - objects key by key, lists of records (a talent file's videos) by id;
//  - whichever side changed a value since base wins; if both did, ours does
//    (this job's answer is the fresher one);
//  - a record either side added is kept; one is removed only if a side removed
//    it on purpose and the other left it untouched;
//  - a video the watcher typed by innertube keeps that type and lock;
//  - a talent file's videos are re-sorted newest first and recounted.
// Anything that is not JSON is taken from this job as a whole file.
//
// Usage (in a workflow, after `git fetch origin main`):
//   node scripts/merge-data.js <base-sha>
// It resets the working tree to origin/main and writes the merged files there,
// ready for `git add` / `git commit`.

const { execFileSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 30 });
const show = (rev, file) => { try { return git('show', `${rev}:${file}`); } catch { return null; } };

const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const eq = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
const idList = a => Array.isArray(a) && a.every(x => isObj(x) && typeof x.id === 'string');

function merge(b, o, t) {
  if (eq(o, b)) return t;
  if (eq(t, b)) return o;
  if (eq(o, t)) return o;
  if (isObj(o) && isObj(t)) {
    const bb = isObj(b) ? b : {};
    const out = {};
    for (const k of new Set([...Object.keys(t), ...Object.keys(o)])) {
      const r = merge(bb[k], o[k], t[k]);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  if (idList(o) && idList(t)) return mergeById(idList(b) ? b : [], o, t);
  return o;                                  // a real conflict: this job's value
}

function mergeById(b, o, t) {
  const bm = new Map(b.map(x => [x.id, x]));
  const om = new Map(o.map(x => [x.id, x]));
  const tm = new Map(t.map(x => [x.id, x]));
  const out = [];
  for (const id of new Set([...om.keys(), ...tm.keys()])) {
    const tr = tm.get(id);
    // A record that was there and one side removed stays removed, even if the
    // other side edited it meanwhile: removals are deliberate (the one-time
    // cleanup, a duplicate collapsed), edits to a doomed record are not.
    if (bm.has(id) && (!om.has(id) || !tm.has(id))) continue;
    const r = merge(bm.get(id), om.get(id), tr);
    if (r === undefined) continue;
    // The watcher's innertube type is the ground truth; nothing overrides it.
    const or = om.get(id);
    if (isObj(r) && isObj(tr) && tr.typedBy === 'innertube' && !(isObj(or) && or.typedBy === 'innertube')) {
      r.type = tr.type; r.typedBy = 'innertube';
    }
    out.push(r);
  }
  return out;
}

// Talent files are kept newest first with a matching count, the same as every
// script that saves one.
function tidy(doc) {
  if (isObj(doc) && Array.isArray(doc.videos) && isObj(doc.channel)) {
    doc.videos.sort((a, b) => new Date(b.published) - new Date(a.published));
    doc.videoCount = doc.videos.length;
  }
  return doc;
}

// Written the way the job wrote it: pretty or compact, trailing newline or not.
function format(value, like) {
  const pretty = /^[\[{]\r?\n/.test(like || '');
  const body = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  return body + (/\n$/.test(like || '') ? '\n' : '');
}

function mergeFile(file, base) {
  const [b, o, t] = [show(base, file), show('HEAD', file), show('origin/main', file)];
  if (o === t) return { text: o };
  if (o === b) return { text: t };            // not really ours to write
  if (t === b || t === null && b === null) return { text: o };
  if (o === null) return { text: b === t ? null : t };   // we deleted it; keep theirs if they changed it
  if (!file.endsWith('.json')) return { text: o };
  let bj = null, oj, tj;
  try { oj = JSON.parse(o); tj = JSON.parse(t); if (b !== null) bj = JSON.parse(b); }
  catch { return { text: o }; }
  const m = tidy(merge(bj, oj, tj));
  if (eq(m, oj)) return { text: o, merged: true };
  if (eq(m, tj)) return { text: t, merged: true };
  return { text: format(m, o), merged: true };
}

function main() {
  const base = process.argv[2];
  if (!base) { console.error('usage: node scripts/merge-data.js <base-sha>'); process.exit(2); }
  const files = git('diff', '--name-only', '--no-renames', base, 'HEAD', '--', 'data/')
    .split('\n').filter(Boolean);

  const results = new Map();
  let merged = 0;
  for (const f of files) {
    const r = mergeFile(f, base);
    results.set(f, r.text);
    if (r.merged) merged++;
  }

  git('reset', '--hard', 'origin/main');
  for (const [f, text] of results) {
    if (text === null) { fs.rmSync(f, { force: true }); continue; }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  console.log(`merge-data: ${files.length} file(s) from this job onto main, ${merged} merged by content`);
}

module.exports = { merge, mergeById, tidy };
if (require.main === module) main();
