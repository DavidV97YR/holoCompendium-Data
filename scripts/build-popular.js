#!/usr/bin/env node
/**
 * build-popular.js
 *
 * Reads every channel JSON + companion views JSON and produces a single
 * data/popular.json with the most-viewed content for three time windows,
 * split by content type (streams, videos, shorts).
 *
 * Run after fetch-views.js so view counts are fresh.
 *
 * Output shape (data/popular.json):
 * {
 *   "lastUpdated": "...",
 *   "streams": { "daily": [...], "weekly": [...], "monthly": [...] },
 *   "videos":  { "daily": [...], "weekly": [...], "monthly": [...] },
 *   "shorts":  { "daily": [...], "weekly": [...], "monthly": [...] }
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

const CONTENT_TYPES = ['stream', 'video', 'short'];

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

  // Pools keyed by content type
  const pools = { stream: [], video: [], short: [] };

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
      if (!CONTENT_TYPES.includes(v.type) || !v.published) continue;
      // Skip member-only content (no accurate public view counts)
      if (v.type === 'member') continue;
      const vc = views[v.id];
      if (vc == null || vc <= 0) continue;

      pools[v.type].push({
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

  for (const [type, pool] of Object.entries(pools)) {
    console.log(`  ${type}s: ${pool.length} public entries with views`);
  }
  console.log('');

  const result = { lastUpdated: new Date().toISOString() };

  for (const [type, pool] of Object.entries(pools)) {
    const key = type + 's';          // stream → streams, video → videos, short → shorts
    result[key] = {};

    for (const [period, cutoff] of Object.entries(WINDOWS)) {
      const list = pool
        .filter(v => new Date(v.published).getTime() >= cutoff)
        .sort((a, b) => b.views - a.views)
        .slice(0, LIMIT);
      result[key][period] = list;
      console.log(`  ${key.padEnd(7)} ${period.padEnd(7)} → ${list.length} entries`);
    }
  }

  const out = path.join(DATA_DIR, 'popular.json');
  fs.writeFileSync(out, JSON.stringify(result, null, 2), 'utf8');
  console.log(`\n✓  ${out}\n`);
}

main();
