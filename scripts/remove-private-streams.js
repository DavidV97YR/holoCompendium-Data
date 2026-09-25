'use strict';

// ── One-time cleanup: remove private / deleted Past Streams ─────────────────
// Before the watcher (watch-new.js), a video in none of the Videos / Shorts /
// Members feeds was saved as a "stream" by elimination, so a private stream
// from those days may really have been anything. This removes every such
// record: type "stream", a Past Stream (status past or none) or one already
// hidden as "unavailable" (a cancelled waiting room, or a stream taken down),
// and no longer returned by the YouTube Data API (private or deleted).
//
// Left alone:
//  - the hololive branch (ASOBI★MAWARI-TAI!), whose test streams are kept;
//  - anything the watcher identified (typedBy set): from here on a private
//    stream is known to be one;
//  - upcoming / live records: the status check follows those.
//
// Safe by default: DRY_RUN is on unless DRY_RUN=false, and it only lists what
// it would remove. If any Data API request fails, nothing is removed at all.
// Quota: 1 unit per 50 streams, about 1,600 units for the whole catalogue.

const fs   = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || './data';
const DRY_RUN  = process.env.DRY_RUN !== 'false';
const SKIP_BRANCHES = new Set(['hololive']);
const PENDING_STATUS = new Set(['upcoming', 'live']);

async function visibleIds(ids, key) {
  const seen = new Set();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const qs = new URLSearchParams({ part: 'id', id: batch.join(','), key, maxResults: '50' });
    const r = await fetch('https://www.googleapis.com/youtube/v3/videos?' + qs);
    if (!r.ok) throw new Error(`Data API HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    for (const item of (await r.json()).items || []) seen.add(item.id);
    if (i + 50 < ids.length) await new Promise(res => setTimeout(res, 100));
  }
  return seen;
}

async function main() {
  const key = process.env.YT_API_KEY;
  if (!key) throw new Error('YT_API_KEY is not set');

  const files = [];
  for (const branch of fs.readdirSync(DATA_DIR)) {
    const dir = path.join(DATA_DIR, branch);
    if (!fs.statSync(dir).isDirectory() || SKIP_BRANCHES.has(branch) || branch === 'posts') continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json') || /-(chat|views)\.json$/.test(name)) continue;
      const file = path.join(dir, name);
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(doc.videos)) files.push({ file, label: `${branch}/${name.replace(/\.json$/, '')}`, doc });
    }
  }

  const isCandidate = v => v.type === 'stream' && !PENDING_STATUS.has(v.status) && !v.typedBy;
  const ids = [...new Set(files.flatMap(f => f.doc.videos.filter(isCandidate).map(v => v.id)))];
  console.log(`${files.length} talent files, ${ids.length} streams to check against the Data API...`);

  const visible = await visibleIds(ids, key);   // throws on any failure: nothing is removed
  const gone = new Set(ids.filter(id => !visible.has(id)));
  console.log(`${gone.size} are private or deleted.\n`);

  let removed = 0;
  for (const f of files) {
    const drop = f.doc.videos.filter(v => isCandidate(v) && gone.has(v.id));
    if (!drop.length) continue;
    for (const v of drop) {
      console.log(`  ${DRY_RUN ? 'would remove' : 'removed'}  ${f.label}  ${v.id}  ${(v.published || '').slice(0, 10)}`
                + `  ${v.status === 'unavailable' ? 'unavailable' : 'past stream'}`
                + `  ${v.actualStart ? 'aired' : 'no start time'}  ${(v.title || '').slice(0, 50)}`);
    }
    removed += drop.length;
    if (DRY_RUN) continue;
    f.doc.videos      = f.doc.videos.filter(v => !(isCandidate(v) && gone.has(v.id)));
    f.doc.videoCount  = f.doc.videos.length;
    f.doc.lastUpdated = new Date().toISOString();
    fs.writeFileSync(f.file, JSON.stringify(f.doc, null, 2), 'utf8');
  }

  console.log(`\n${DRY_RUN ? 'DRY RUN — nothing changed. Would remove' : 'Removed'} ${removed} record(s)`
            + ` (${gone.size} unique video(s); a shared channel has one record per talent).`);
}

main().catch(e => { console.error(e); process.exit(1); });
