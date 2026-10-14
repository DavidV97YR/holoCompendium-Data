#!/usr/bin/env node
/**
 * fetch-music.js
 *
 * Records which videos YouTube marks as music — the note on the duration
 * badge in each channel's Videos tab (innertube.js musicVideos) — into the
 * "music" list of each talent's {slug}-views.json, beside the view counts.
 * The talent page draws the note from it, and build-sqlite.js / build-music.js
 * turn it into the Music page. Runs in Update Channel Data, every two hours,
 * just before the catalogue is built, so a new song reaches both within one
 * run. No quota: innertube, not the Data API.
 *
 * Only the "music" key is written; fetch-views.js owns the rest of the file
 * and carries the list over when it rewrites the views. A mark is dropped only
 * when the tab shows that video without the note: a video gone from the tab
 * (made unlisted) keeps it, and a walk cut short only adds marks.
 *
 * Env:
 *   DATA_DIR — data folder (default: ./data); ./vspo for VSPO!
 */

const fs   = require('fs');
const path = require('path');
const { musicVideos } = require('./innertube');

const DATA_DIR = process.env.DATA_DIR || './data';
const CONCURRENCY = 4;   // channels walked at once; each walk pauses between its pages

// Channel files, as fetch-views.js finds them.
function channelFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const branch of fs.readdirSync(dir)) {
    const bp = path.join(dir, branch);
    if (branch === 'posts' || !fs.statSync(bp).isDirectory()) continue;
    for (const f of fs.readdirSync(bp)) {
      if (f.endsWith('.json') && !/-(views|chat)\.json$/.test(f)) out.push(path.join(bp, f));
    }
  }
  return out;
}

async function main() {
  const files = channelFiles(DATA_DIR);
  if (!files.length) { console.error('No channel files in ' + DATA_DIR); process.exit(1); }

  // FUWAMOCO and the mekPark units share a channel: walked once, written to
  // each genmate's views file.
  const byChannel = new Map();   // channelId -> [{ file, name }]
  for (const fp of files) {
    let ch;
    try { ch = JSON.parse(fs.readFileSync(fp, 'utf8')).channel || {}; } catch { continue; }
    if (!ch.id) continue;
    if (!byChannel.has(ch.id)) byChannel.set(ch.id, []);
    byChannel.get(ch.id).push({ file: fp, name: ch.name || path.basename(fp, '.json') });
  }

  const ids = [...byChannel.keys()];
  const walks = new Map();
  let next = 0;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < ids.length) {
      const id = ids[next++];
      walks.set(id, await musicVideos(id));
    }
  }));

  let changed = 0, incomplete = 0, marks = 0;
  for (const [id, owners] of byChannel) {
    const walk = walks.get(id);
    if (!walk.complete) incomplete++;
    for (const { file, name } of owners) {
      const vp = file.replace(/\.json$/, '-views.json');
      let doc = null;
      try { doc = JSON.parse(fs.readFileSync(vp, 'utf8')); } catch { /* none yet */ }
      const had = (doc && doc.music) || [];
      // A mark goes only when the tab shows the video without the note. One
      // that has left the tab (unlisted, like Toto's members-only Donut Hole
      // cover) keeps its mark, as does every mark when the walk was cut short.
      const keep = walk.complete ? had.filter(v => !walk.seenIds.has(v)) : had;
      const music = [...new Set([...keep, ...walk.ids])].sort();
      marks += music.length;
      if (doc && music.join() === had.join()) continue;
      // Nothing to record and no file yet (a deleted channel: Rushia, Mel).
      if (!doc && !music.length) continue;
      // A talent fetch-views.js has not reached yet gets a file of its own,
      // in the same shape; its view counts are filled in by that job.
      doc = doc || { channelId: id, channelName: name, lastUpdated: new Date().toISOString(), views: {} };
      doc.music = music;
      fs.writeFileSync(vp, JSON.stringify(doc, null, 2), 'utf8');
      changed++;
      console.log('  ✓ ' + path.relative(DATA_DIR, vp) + '  ' + had.length + ' → ' + music.length);
    }
  }
  console.log('\n  ' + byChannel.size + ' channels walked in ' + Math.round((Date.now() - t0) / 1000) + 's, '
              + changed + ' file(s) changed, ' + marks + ' marks'
              + (incomplete ? ', ' + incomplete + ' walk(s) incomplete (previous marks kept)' : '') + '\n');
}

main().catch(e => { console.error(e); process.exit(1); });
