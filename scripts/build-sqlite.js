#!/usr/bin/env node
/**
 * build-sqlite.js
 *
 * Reads every channel JSON + companion views JSON and produces a single
 * data.sqlite containing the whole catalogue — not just the slices some
 * feature happens to need today.
 *
 * The file is published to R2 and queried directly from the browser over HTTP
 * range requests (sql.js-httpvfs), so there is no server and no row quota:
 * each run replaces one object rather than writing ~100k rows.
 *
 * Env:
 *   DATA_DIR — path to data folder (default: ./data)
 *   OUT      — output path        (default: ./data.sqlite)
 */

const fs      = require('fs');
const path    = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || './data';
const OUT      = process.env.OUT      || './data.sqlite';

// Talents who share one YouTube channel. Mirrors CHANNEL_ALIASES in the site's
// shared.js — without this a shared channel would be stored under whichever
// genmate's file happened to load last.
const CANONICAL = {
  'Fuwawa Abyssgard': 'FUWAMOCO',
  'Mococo Abyssgard': 'FUWAMOCO',
  'Yoinagi Neon':     'UNIT B',
  'Reimei Mira':      'UNIT B',
  'Kiyosumi Lyra':    'UNIT B',
  'Sumishio Sayana':  'ACHRORA',
  'Rumigaki Rirara':  'ACHRORA',
  'Yuikawa Hinami':   'ACHRORA',
};

function channelFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const branch of fs.readdirSync(dir)) {
    const bp = path.join(dir, branch);
    if (!fs.statSync(bp).isDirectory()) continue;
    for (const f of fs.readdirSync(bp)) {
      if (f.endsWith('.json') && !f.endsWith('-views.json')) out.push(path.join(bp, f));
    }
  }
  return out;
}

// How complete a record is. The same upload can appear in several talent files
// (FUWAMOCO, the mekPark units); keep whichever copy carries the most.
const score = v => (v.duration ? 4 : 0) + (v.status ? 2 : 0) + (v.views != null ? 1 : 0);

function main() {
  const files = channelFiles(DATA_DIR);
  if (!files.length) { console.error(`No channel files in ${DATA_DIR}`); process.exit(1); }
  console.log(`\n  ${files.length} channel file(s)\n`);

  const channels = new Map();  // channelId -> row
  const videos   = new Map();  // videoId   -> row

  for (const fp of files) {
    let data;
    try { data = JSON.parse(fs.readFileSync(fp, 'utf8')); }
    catch (e) { console.error(`  x ${fp}: ${e.message}`); continue; }

    const ch = data.channel || {};
    const chId = ch.id;
    if (!chId) { console.error(`  x ${fp}: no channel.id`); continue; }

    const branch = path.basename(path.dirname(fp));
    const name   = CANONICAL[ch.name] || ch.name || path.basename(fp, '.json');
    if (!channels.has(chId)) {
      channels.set(chId, { id: chId, name, branch, avatar: ch.avatarUrl || '' });
    }

    let views = {};
    const vp = fp.replace(/\.json$/, '-views.json');
    if (fs.existsSync(vp)) {
      try { views = JSON.parse(fs.readFileSync(vp, 'utf8')).views || {}; } catch (_) {}
    }

    for (const v of (data.videos || [])) {
      if (!v.id || !v.published) continue;
      const ts = Math.floor(Date.parse(v.published) / 1000);
      if (!Number.isFinite(ts)) continue;
      const vc = views[v.id];
      const row = {
        id: v.id, channel_id: chId,
        title: v.title || '', published: ts,
        duration: v.duration || 0, type: v.type || 'stream',
        status: v.status || null,
        views: (vc != null && vc > 0) ? vc : null,
      };
      const prev = videos.get(v.id);
      if (!prev || score(row) > score(prev)) videos.set(v.id, row);
    }
  }

  if (fs.existsSync(OUT)) fs.unlinkSync(OUT);
  const db = new Database(OUT);
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');

  db.exec(`
    CREATE TABLE channels (
      id     TEXT PRIMARY KEY,
      name   TEXT NOT NULL,
      branch TEXT,
      avatar TEXT
    );
    CREATE TABLE videos (
      id         TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id),
      title      TEXT NOT NULL,
      published  INTEGER NOT NULL,
      duration   INTEGER NOT NULL DEFAULT 0,
      type       TEXT NOT NULL,
      status     TEXT,
      views      INTEGER
    );
  `);

  const insCh = db.prepare('INSERT INTO channels (id,name,branch,avatar) VALUES (?,?,?,?)');
  const insV  = db.prepare(`INSERT INTO videos
    (id,channel_id,title,published,duration,type,status,views) VALUES (?,?,?,?,?,?,?,?)`);

  db.transaction(() => {
    for (const c of channels.values()) insCh.run(c.id, c.name, c.branch, c.avatar);
    for (const v of videos.values())
      insV.run(v.id, v.channel_id, v.title, v.published, v.duration, v.type, v.status, v.views);
  })();

  // Popular is (type, published, views); the rest are the cross-channel queries
  // this file exists to make possible.
  db.exec(`
    CREATE INDEX idx_videos_popular   ON videos(type, published DESC, views DESC);
    CREATE INDEX idx_videos_channel   ON videos(channel_id, published DESC);
    CREATE INDEX idx_videos_published ON videos(published DESC);
  `);

  // Range requests read pages, so the file must be contiguous and unfragmented.
  db.exec('VACUUM');
  db.exec('ANALYZE');

  const withViews = db.prepare('SELECT COUNT(*) n FROM videos WHERE views > 0').get().n;
  const byType = db.prepare('SELECT type, COUNT(*) n FROM videos GROUP BY type ORDER BY n DESC').all();
  db.close();

  const mb = (fs.statSync(OUT).size / 1048576).toFixed(1);
  console.log(`  channels         : ${channels.size}`);
  console.log(`  videos           : ${videos.size.toLocaleString()}`);
  console.log(`  with view counts : ${withViews.toLocaleString()}`);
  byType.forEach(r => console.log(`    ${String(r.type).padEnd(7)} ${r.n.toLocaleString()}`));
  console.log(`\n  ${OUT}  ${mb} MB\n`);
}

main();
