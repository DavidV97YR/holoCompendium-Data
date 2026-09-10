#!/usr/bin/env node
/**
 * build-popular.js
 *
 * Produces popular.json — the most-viewed content for three rolling windows,
 * split by content type — by querying the SQLite catalogue built by
 * build-sqlite.js. Run after it.
 *
 * This used to scan every channel JSON here, and then for a while the browser
 * ran the queries itself against the catalogue over HTTP. Both are gone: the
 * SQL below is the browser's, moved back to build time. The home page fetches
 * the result instead of downloading a 507 KB SQLite engine and issuing hundreds
 * of range requests to compute an answer that only changes when this runs.
 *
 * Keeping it in SQL is what preserves the de-duplication: talents who share a
 * channel (FUWAMOCO, the mekPark units) used to appear once per genmate, so a
 * duplicate inside the top 40 cost a slot and a section rendered 39.
 *
 * Output shape:
 * {
 *   "lastUpdated": "...",
 *   "streams": { "daily": [...], "weekly": [...], "monthly": [...] },
 *   "videos":  { ... },
 *   "shorts":  { ... }
 * }
 *
 * Env:
 *   DB  — catalogue to read  (default: ./data.sqlite)
 *   OUT — file to write      (default: ./popular.json)
 *
 * OUT defaults outside data/ on purpose: the workflow stages only data/, and a
 * 78 KB file that changes every run has no business in git history.
 */

const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DB    = process.env.DB  || './data.sqlite';
const OUT   = process.env.OUT || './popular.json';
const LIMIT = 40;

// Rolling windows measured from now, matching what the page used to ask for:
// Today = the last 24 hours, This Week = 7 days, This Month = 30 days.
const WINDOWS = { daily: 1, weekly: 7, monthly: 30 };
const TYPES   = { streams: 'stream', videos: 'video', shorts: 'short' };

const SQL = `
  SELECT v.id, v.title, v.published, v.duration, v.views,
         c.name AS channelName, c.avatar AS channelAvatar
  FROM videos v
  JOIN channels c ON c.id = v.channel_id
  WHERE v.type = ?
    AND v.published >= strftime('%s', 'now', ?)
    AND v.views > 0
  ORDER BY v.views DESC, v.id
  LIMIT ${LIMIT}`;

function main() {
  if (!fs.existsSync(DB)) {
    console.error('No catalogue at ' + DB + ' — run build-sqlite.js first');
    process.exit(1);
  }

  const db  = new DatabaseSync(DB, { readOnly: true });
  const q   = db.prepare(SQL);
  const out = { lastUpdated: new Date().toISOString() };

  for (const [key, type] of Object.entries(TYPES)) {
    out[key] = {};
    for (const [period, days] of Object.entries(WINDOWS)) {
      const rows = q.all(type, '-' + days + ' days');
      // published is stored as unix seconds; the cards want an ISO string.
      out[key][period] = rows.map(r => Object.assign({}, r, {
        published: new Date(Number(r.published) * 1000).toISOString(),
        views: Number(r.views),
      }));
      console.log('  ' + key.padEnd(8) + period.padEnd(8) + '→ ' + rows.length + ' entries');
    }
  }
  db.close();

  fs.writeFileSync(OUT, JSON.stringify(out), 'utf8');
  const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
  console.log('\n  ' + OUT + '  ' + kb + ' KB\n');
}

main();
