#!/usr/bin/env node
/**
 * build-music.js
 *
 * Produces music.json — every video YouTube marks as music (the ♪ on its
 * duration badge, read off each channel's Videos tab by fetch-views.js), from
 * every talent, for the site's Music page. Reads the SQLite catalogue built by
 * build-sqlite.js, so a video on a shared channel (FUWAMOCO, the mekPark
 * units) is listed once, under the channel's own name. Run after it.
 *
 * Members-only music is included and flagged: the page shows it with a
 * Members label and lets the reader hide it. YouTube gives no view count for
 * it, so `v` is null there.
 *
 * Output shape (one entry per video, newest first; short keys, as the page
 * reads the whole file):
 * {
 *   "lastUpdated": "...",
 *   "channels": [ { "name", "avatar", "branch" }, ... ],
 *   "items": [ { "id", "t": title, "p": published ISO, "d": seconds,
 *                "v": views | null, "m": 1 if members-only, "c": channel index }, ... ]
 * }
 *
 * Env:
 *   DB  — catalogue to read  (default: ./data.sqlite)
 *   OUT — file to write      (default: ./music.json)
 *
 * OUT defaults outside data/, as popular.json does: it is published to R2,
 * not committed.
 */

const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DB  = process.env.DB  || './data.sqlite';
const OUT = process.env.OUT || './music.json';

const SQL = `
  SELECT v.id, v.title, v.published, v.duration, v.views, v.type,
         c.id AS chId, c.name, c.avatar, c.branch
  FROM videos v
  JOIN channels c ON c.id = v.channel_id
  WHERE v.music = 1
    AND v.type IN ('video', 'member')
    -- Hidden everywhere on the site, as in build-popular.js.
    AND (v.status IS NULL OR v.status != 'unavailable')
  ORDER BY v.published DESC, v.id`;

function main() {
  if (!fs.existsSync(DB)) {
    console.error('No catalogue at ' + DB + ' — run build-sqlite.js first');
    process.exit(1);
  }
  const db = new DatabaseSync(DB, { readOnly: true });
  // A catalogue from before the music column has nothing to list.
  const cols = db.prepare('PRAGMA table_info(videos)').all().map(c => c.name);
  const rows = cols.includes('music') ? db.prepare(SQL).all() : [];
  db.close();

  const channels = [], index = new Map();
  const items = rows.map(r => {
    if (!index.has(r.chId)) {
      index.set(r.chId, channels.length);
      channels.push({ name: r.name, avatar: r.avatar || '', branch: r.branch || '' });
    }
    const it = {
      id: r.id,
      t:  r.title,
      p:  new Date(Number(r.published) * 1000).toISOString(),
      d:  Number(r.duration) || 0,
      v:  r.views != null ? Number(r.views) : null,
      c:  index.get(r.chId),
    };
    if (r.type === 'member') it.m = 1;
    return it;
  });

  fs.writeFileSync(OUT, JSON.stringify({ lastUpdated: new Date().toISOString(), channels, items }), 'utf8');
  const members = items.filter(i => i.m).length;
  const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
  console.log('\n  ' + items.length + ' music videos (' + members + ' members-only) from '
              + channels.length + ' channels\n  ' + OUT + '  ' + kb + ' KB\n');
}

main();
