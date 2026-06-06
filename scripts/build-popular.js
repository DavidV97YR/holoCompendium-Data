#!/usr/bin/env node
/**
 * build-popular.js
 *
 * Reads every channel JSON + companion views JSON and produces a single
 * data/popular.json with the most-viewed streams for three time windows.
 *
 * Run after fetch-views.js so view counts are fresh.
 *
 * Output shape (data/popular.json):
 * {
 *   "lastUpdated": "...",
 *   "daily":   [ ...top 40 streams published in last 24 h ],
 *   "weekly":  [ ...top 40 streams published in last  7 d ],
 *   "monthly": [ ...top 40 streams published in last 30 d ]
 * }
 *
 * Env:
 *   DATA_DIR — path to data folder (default: ./data)
 */

const fs   = require('fs');
const path = require('path');

const LIMIT    = 40;
const DATA_DIR = process.env.DATA_DIR || './data';

const NOW     = Date.now();
const ONE_DAY = 24 * 60 * 60 * 1000;
const WINDOWS = {
  daily:   NOW - 1  * ONE_DAY,
  weekly:  NOW - 7  * ONE_DAY,
  monthly: NOW - 30 * ONE_DAY,
};

function findChannelFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const branch of fs.readdirSync(dir)) {
    const bp = path.join(dir, branch);
    if (!fs.statSync(bp).isDirectory()) continue;
    for (const f of fs.readdirSync(bp)) {
      if (f.endsWith('.json') && !f.endsWith('-views.json')) {
        out.push(path.join(bp, f));
      }
    }
  }
  return out;
}

function main() {
  const files = findChannelFiles(DATA_DIR);
  if (!files.length) {
    console.error(`No channel files found in ${DATA_DIR}`);
    process.exit(1);
  }

  console.log(`\n📂  ${files.length} channel file(s)\n`);

  const pool = [];

  for (const fp of files) {
    let data;
    try { data = JSON.parse(fs.readFileSync(fp, 'utf8')); }
    catch (e) { console.error(`  ✗ ${fp}: ${e.message}`); continue; }

    const ch     = data.channel || {};
    const videos = data.videos  || [];
    if (!videos.length) continue;

    const viewsPath = fp.replace(/\.json$/, '-views.json');
    let views = {};
    if (fs.existsSync(viewsPath)) {
      try { views = JSON.parse(fs.readFileSync(viewsPath, 'utf8')).views || {}; }
      catch (_) {}
    }

    for (const v of videos) {
      if (v.type !== 'stream' || !v.published) continue;
      const vc = views[v.id];
      if (vc == null || vc <= 0) continue;

      pool.push({
        id:            v.id,
        title:         v.title   || '',
        published:     v.published,
        duration:      v.duration || 0,
        views:         vc,
        channelName:   ch.name      || '',
        channelAvatar: ch.avatarUrl || '',
      });
    }
  }

  console.log(`  Pooled ${pool.length} public streams with views\n`);

  const result = { lastUpdated: new Date().toISOString() };

  for (const [period, cutoff] of Object.entries(WINDOWS)) {
    const list = pool
      .filter(v => new Date(v.published).getTime() >= cutoff)
      .sort((a, b) => b.views - a.views)
      .slice(0, LIMIT);
    result[period] = list;
    console.log(`  ${period.padEnd(7)} → ${list.length} videos`);
  }

  const out = path.join(DATA_DIR, 'popular.json');
  fs.writeFileSync(out, JSON.stringify(result, null, 2), 'utf8');
  console.log(`\n✓  ${out}\n`);
}

main();
