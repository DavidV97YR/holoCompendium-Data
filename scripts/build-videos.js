#!/usr/bin/env node
/**
 * build-videos.js
 *
 * Produces the site's Videos page data: every stream, video, short and
 * members-only upload from every talent. Reads the SQLite catalogue built by
 * build-sqlite.js, as build-music.js does, so a video on a shared channel
 * (FUWAMOCO, the mekPark units) is listed once, under the channel's own name.
 * Run after it.
 *
 * All of it is ~4 MB compressed for hololive, so it is split: recent.json is
 * the last RECENT_DAYS (60), which the page opens on (~0.25 MB), and one file
 * per calendar year holds the rest, fetched only when the reader scrolls past
 * the recent ones or asks for an order that needs everything (Popular,
 * Oldest). A year file holds the whole year, so the current year (and, in
 * January and February, the previous one) overlaps recent.json; the page
 * drops the ids it already has. recent.json was a whole year until
 * 2026-10-30: 1.3 MB to download and 4.5 MB to read before the page drew its
 * first 48 cards.
 *
 * Left out, as the talent pages leave them out: deleted videos (status
 * "unavailable"), and anything still upcoming or live, which is not a video
 * yet — it arrives here once it has aired.
 *
 * Output (short keys, as the page reads whole files; newest first):
 *   OUT_DIR/recent.json
 *     { "lastUpdated", "cutoff": ISO, "years": [ { "y", "n" }, ... ],
 *       "channels": [ { "name", "avatar", "branch" }, ... ],
 *       "tally": [ [streams, videos, shorts, members], ... ]  (all years, one
 *                  per channel, in channels order), "items": [...] }
 *   The tally lets the page give the exact count for any branch, type and
 *   talent choice before the older years have loaded.
 *   OUT_DIR/<year>.json
 *     { "lastUpdated", "year", "channels": [...], "items": [...] }
 * Each item: { "id", "t": title, "p": published ISO, "s": start ISO (streams,
 *   members-only ones too, with a recorded start), "d": seconds, "v": views (left out when none),
 *   "k": "s" stream | "v" video | "h" short | "m" members-only,
 *   "u": 1 when YouTube marks it as music (fetch-music.js), "c": index into
 *   that file's channels }
 * Every file carries the whole channels list, newest activity first, so the
 * page's Talents picker can offer a graduated talent before her years have
 * loaded, and files from different runs never disagree about an index.
 *
 * Env:
 *   DB      — catalogue to read   (default: ./data.sqlite)
 *   OUT_DIR — folder to write to  (default: ./videos)
 *
 * OUT_DIR defaults outside data/, as music.json does: it is published to R2,
 * not committed. Files from an earlier run are removed first, so a year that
 * no longer has anything in it does not linger.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB      = process.env.DB      || './data.sqlite';
const OUT_DIR = process.env.OUT_DIR || './videos';
const KIND    = { stream: 's', video: 'v', short: 'h', member: 'm' };
const RECENT_DAYS = 60;

// A catalogue from before the music column reads every video as not music.
const sql = music => `
  SELECT v.id, v.title, v.published, v.duration, v.views, v.type, v.actual_start,
         ${music ? 'v.music' : '0'} AS music, c.id AS chId, c.name, c.avatar, c.branch
  FROM videos v
  JOIN channels c ON c.id = v.channel_id
  WHERE v.type IN ('stream', 'video', 'short', 'member')
    AND (v.status IS NULL OR v.status NOT IN ('unavailable', 'upcoming', 'live'))`;

// When it happened, as the site dates it: a stream by its start, everything
// else by its upload. A stream with no recorded start is dated its upload
// less its running time, as streamStart() in the site's shared.js does.
// A members-only item with a recorded start was a stream too (an upload has
// none): its `published` is when the waiting room went up — Marine's
// watchalong read 4:03 AM for a stream that began at 6:05.
function when(r) {
  const pub = Number(r.published) * 1000;
  if (r.type === 'member' && r.actual_start != null) return Number(r.actual_start) * 1000;
  if (r.type !== 'stream') return pub;
  if (r.actual_start != null) return Number(r.actual_start) * 1000;
  return pub - (Number(r.duration) || 0) * 1000;
}

function main() {
  if (!fs.existsSync(DB)) {
    console.error('No catalogue at ' + DB + ' — run build-sqlite.js first');
    process.exit(1);
  }
  const db = new DatabaseSync(DB, { readOnly: true });
  const cols = db.prepare('PRAGMA table_info(videos)').all().map(c => c.name);
  const rows = db.prepare(sql(cols.includes('music'))).all();
  db.close();

  const now = Date.now(), lastUpdated = new Date(now).toISOString();
  const cutoff = now - RECENT_DAYS * 86400000;
  rows.forEach(r => { r.at = when(r); });
  rows.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));

  // Every channel, in order of its newest item.
  const channels = [], index = new Map();
  rows.forEach(r => {
    if (index.has(r.chId)) return;
    index.set(r.chId, channels.length);
    channels.push({ name: r.name, avatar: r.avatar || '', branch: r.branch || '' });
  });

  function pack(list) {
    const items = list.map(r => {
      const it = { id: r.id, t: r.title, p: new Date(Number(r.published) * 1000).toISOString() };
      if ((r.type === 'stream' || r.type === 'member') && r.actual_start != null) it.s = new Date(Number(r.actual_start) * 1000).toISOString();
      it.d = Number(r.duration) || 0;
      if (r.views != null && Number(r.views) > 0) it.v = Number(r.views);
      it.k = KIND[r.type];
      if (Number(r.music) === 1) it.u = 1;
      it.c = index.get(r.chId);
      return it;
    });
    return { channels, items };
  }

  const byYear = new Map();
  rows.forEach(r => {
    const y = new Date(r.at).getUTCFullYear();
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(r);
  });
  const years = [...byYear.keys()].sort((a, b) => b - a);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const f of fs.readdirSync(OUT_DIR)) if (/^(recent|\d{4})\.json$/.test(f)) fs.unlinkSync(path.join(OUT_DIR, f));

  const write = (name, obj) => {
    const fp = path.join(OUT_DIR, name);
    fs.writeFileSync(fp, JSON.stringify(obj), 'utf8');
    return (fs.statSync(fp).size / 1048576).toFixed(2) + ' MB';
  };

  const tally = channels.map(() => [0, 0, 0, 0]);
  const slot = { stream: 0, video: 1, short: 2, member: 3 };
  rows.forEach(r => { tally[index.get(r.chId)][slot[r.type]]++; });

  const recent = rows.filter(r => r.at >= cutoff);
  const { items: recentItems } = pack(recent);
  const out = ['recent.json  ' + recent.length + ' items  ' + write('recent.json', {
    lastUpdated, cutoff: new Date(cutoff).toISOString(),
    years: years.map(y => ({ y, n: byYear.get(y).length })),
    channels, tally, items: recentItems,
  })];
  for (const y of years) {
    out.push(y + '.json  ' + byYear.get(y).length + ' items  ' + write(y + '.json', { lastUpdated, year: y, ...pack(byYear.get(y)) }));
  }

  const counts = {};
  rows.forEach(r => { counts[r.type] = (counts[r.type] || 0) + 1; });
  console.log('\n  ' + rows.length + ' items ' + JSON.stringify(counts) + '\n  ' + out.join('\n  ') + '\n');
}

main();
