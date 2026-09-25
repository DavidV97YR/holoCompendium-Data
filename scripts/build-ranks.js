#!/usr/bin/env node
/**
 * build-ranks.js
 *
 * Produces ranks.json — the per-talent aggregates the site's /rank page sorts
 * into leaderboards. Run from update.yml alongside build-popular.js.
 *
 * Why this is precomputed, like popular.json before it: answering "who earned
 * the most superchats of all time" in the browser means downloading ~43 MB of
 * channel JSON and ~40 MB of chat JSON. The six boards on /rank are the same
 * handful of aggregates over that whole corpus, and they only change when this
 * repo does — so they are computed once here, into ~120 KB.
 *
 * This reads DATA_DIR directly rather than the SQLite catalogue, because the
 * catalogue is keyed by channel id and knows nothing about file slugs, and the
 * page's links are "/<branch>/<slug>". It repeats build-sqlite.js's CANONICAL
 * map and its "a shared channel counts once" rule for the same reason that file
 * has them: FUWAMOCO and the mekPark units are several talents on one channel,
 * and counting the channel per genmate would put it three times on every board.
 *
 * Output shape (keys are readable rather than packed — Cloudflare gzips this on
 * the way out, and the repetition compresses to nothing anyway):
 *
 * {
 *   "lastUpdated": "2026-09-21T...",
 *   "windowDays": { "d1": 1, "d7": 7, "d30": 30 },   // "all" is unbounded
 *   "talents": [{
 *     "key": "jp/hakui-koyori", "name": "Hakui Koyori",
 *     "branch": "jp", "avatar": "https://yt3.ggpht.com/...",
 *     "streak": { "cur": 5, "max": 87 },
 *     "w": { "d1": { streams, hours, views, yen, sc, members, gifts }, ... },
 *     "top": { "d1": { "m": <stream>|null, "v": <stream>|"m"|null }, ... }
 *   }]
 * }
 *
 * PUBLIC STREAMS ONLY. Members-only content is not counted anywhere, because
 * the type here is the PLAYLIST a video came from: "member" is the members-only
 * playlist, holding streams, videos and shorts together. Koyori's 111 include a
 * 0.3-minute "#Shorts" and a vertical dance clip. There is no way to separate
 * the streams back out, so counting the bucket as stream hours would invent
 * time that was never streamed.
 *
 * Chat data is public-only regardless: fetch-chat.js filters on
 * `v.type === 'stream'` and could not do otherwise, since a members-only replay
 * is gated and the scraper is not signed in.
 *
 * `top.m` is the window's highest-earning stream and `top.v` its most-viewed.
 * Both are public by construction. When one stream tops both, `v` is the string
 * "m" rather than a second copy of it.
 *
 * Env:
 *   DATA_DIR — path to the data folder (default: ./data)
 *   OUT      — file to write           (default: ./ranks.json)
 *   NOW      — clock for the rolling windows (default: the real one). Only for
 *              testing: run against a checkout that is a fortnight old and the
 *              24h and 7-day windows come out legitimately empty, which makes
 *              the page impossible to eyeball. Set it to the newest published
 *              date in the data and they fill.
 *
 * OUT defaults outside data/ for the same reason build-popular.js's does: the
 * workflow stages only data/, and a file that changes every two hours has no
 * business in git history.
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || './data';
const OUT      = process.env.OUT      || './ranks.json';

// Talents who share one YouTube channel, mapped to the channel's own identity.
// Mirrors CANONICAL in build-sqlite.js and CHANNEL_ALIASES in the site's
// shared.js. Without it "Yoinagi Neon" and "Reimei Mira" would each carry
// UNIT B's whole output onto every board.
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

// Rolling windows, matching the ones the home page's Popular sections use, so
// "Last 30 Days" means the same thing everywhere on the site.
const WINDOW_DAYS = { d1: 1, d7: 7, d30: 30 };
const WINDOWS     = ['d1', 'd7', 'd30', 'all'];

// Streaks are counted in Japan Standard Time, not UTC. Almost every one of
// these channels streams in the JST evening, which lands after midnight UTC —
// counting UTC days would split a normal night's stream across two dates and
// invent streaks nobody actually ran.
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS        = 24 * 60 * 60 * 1000;
function jstDay(ms) { return Math.floor((ms + JST_OFFSET_MS) / DAY_MS); }

// When a stream STARTED. `published` is when YouTube posted the VOD — the end
// plus a few minutes — so a 22:00–01:45 JST stream counted toward the next
// day, and a talent who alternates early and late streams got gaps that never
// happened (Kikirara Vivi: longest 30 by end time, 118 by start). Same rule as
// streamStart() in the site's js/shared.js.
function startMs(v, pub) {
  const actual = Date.parse(v.actualStart);           // stored by update.js: the real start
  if (Number.isFinite(actual)) return actual;
  const est   = pub - (v.duration || 0) * 1000;
  const sched = Date.parse(v.scheduledStart);
  if (Number.isFinite(sched) && sched <= pub && sched >= est - 3 * 3600000) return sched;
  return est;
}

// ── Currency → yen ─────────────────────────────────────────────────────────
// A copy of the table in the site's js/stats.js, and it has to stay in step
// with it: the two pages would otherwise print different totals for the same
// streams. EDIT BOTH, always. The "currencies with no rate" report at the end
// of this run is what catches the drift when one gets forgotten.
//
// These are static, approximate rates (USD/JPY ~= 150). See the long note in
// js/stats.js for why they are deliberately not fetched live.
//
// Symbols are whatever fetch-chat.js scraped out of purchaseAmountText, so both
// the glyph forms ("NT$") and the plain codes ("SGD") appear. Note 'F\u202fCFA'
// — YouTube writes it with a NARROW NO-BREAK SPACE, and a plain space here
// silently fails to match and counts the amount as zero.
const JPY_RATES = {
  '¥': 1,
  '$': 150, 'US$': 150, 'USD': 150,
  '€': 163, 'EUR': 163,
  '£': 190, 'GBP': 190,
  '₩': 0.11, 'KRW': 0.11,
  'NT$': 4.7, 'TWD': 4.7,
  'HK$': 19.2, 'HKD': 19.2,
  'CN¥': 21, 'CNY': 21,
  '₱': 2.6, 'PHP': 2.6,
  'CA$': 110, 'CAD': 110,
  'A$': 99, 'AUD': 99,
  'NZ$': 91, 'NZD': 91,
  'SGD': 112, 'S$': 112,
  'MYR': 33, 'RM': 33,
  'THB': 4.3, '฿': 4.3,
  'IDR': 0.0092, 'Rp': 0.0092,
  '₫': 0.0059, 'VND': 0.0059,
  '₹': 1.75, 'INR': 1.75,
  'MX$': 8.3, 'MXN': 8.3,
  'R$': 27, 'BRL': 27,
  'CHF': 175,
  'PLN': 38, 'zł': 38,
  'HUF': 0.42, 'Ft': 0.42,
  'CZK': 6.6, 'Kč': 6.6,
  'SEK': 14.3, 'NOK': 14, 'DKK': 22,
  'RON': 33, 'BGN': 83,
  'TRY': 4.2, '₺': 4.2,
  'ZAR': 8.4, 'R': 8.4,
  'CLP': 0.16, 'ARS': 0.12, 'COP': 0.038, 'PEN': 40,
  'EGP': 3.1, 'CRC': 0.29, 'UYU': 3.7,
  '₪': 41, 'ILS': 41,
  // JOD is pegged to the dollar at 0.709 to 1, so it comes off the USD rate
  // above rather than being guessed: 150 / 0.709.
  'AED': 41, 'SAR': 40, 'QAR': 41, 'JOD': 212,
  '₽': 1.7, 'RUB': 1.7,
  '₴': 3.6, 'UAH': 3.6,
  'NGN': 0.1, 'KES': 1.16, 'PKR': 0.53, 'BDT': 1.24, 'LKR': 0.5,
  // Latin America
  'BOB': 21.7, 'DOP': 2.5, 'GTQ': 19.5, 'HNL': 6, 'NIO': 4.1, 'PYG': 0.0205,
  // Europe. HRK and BAM are hard-pegged to the euro (7.53450 and 1.95583 to
  // one), so they are derived from the EUR rate rather than guessed.
  'ISK': 1.09, 'MKD': 2.63, 'RSD': 1.39, 'BYN': 45.5,
  'HRK': 21.6, 'BAM': 83.3,
  // Africa. XOF and XAF are likewise pegged, at 655.957 to the euro.
  'MAD': 15, 'UGX': 0.04,
  'F\u202fCFA': 0.2485, 'FCFA': 0.2485, 'XOF': 0.2485, 'XAF': 0.2485,
};

// A chat summary entry is either 0 (walked, nothing monetary), an object of
// totals, or { e, n } for a walk that failed and will be retried. Only the
// object counts. Same test as isAnalysed() in the site's stats.js.
function isAnalysed(v) { return v && typeof v === 'object' && !v.e; }

const unknownSymbols = new Map();

function toYen(cur) {
  let yen = 0;
  for (const sym in cur) {
    const rate = JPY_RATES[sym];
    if (rate === undefined) { unknownSymbols.set(sym, (unknownSymbols.get(sym) || 0) + 1); continue; }
    yen += cur[sym] * rate;
  }
  return yen;
}

// ── Reading the data folder ────────────────────────────────────────────────
// A channel file is "<branch>/<slug>.json"; its companions are "-views.json"
// and "-chat.json". Excluding both by suffix is what keeps a chat file from
// being read as a channel.
function channelFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const branch of fs.readdirSync(dir).sort()) {
    const bp = path.join(dir, branch);
    // data/posts/ holds community posts, not channels.
    if (branch === 'posts' || !fs.statSync(bp).isDirectory()) continue;
    for (const f of fs.readdirSync(bp).sort()) {
      if (!f.endsWith('.json')) continue;
      if (f.endsWith('-views.json') || f.endsWith('-chat.json')) continue;
      out.push(path.join(bp, f));
    }
  }
  return out;
}

function readJSON(fp) {
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch (e) { console.error('  x ' + fp + ': ' + e.message); return null; }
}

function emptyWindow() {
  return { streams: 0, hours: 0, views: 0, yen: 0, sc: 0, members: 0, gifts: 0 };
}

function main() {
  const files = channelFiles(DATA_DIR);
  if (!files.length) { console.error('No channel files in ' + DATA_DIR); process.exit(1); }
  console.log('\n  ' + files.length + ' channel file(s)\n');

  const now    = process.env.NOW ? Date.parse(process.env.NOW) : Date.now();
  if (!Number.isFinite(now)) { console.error('NOW is not a date: ' + process.env.NOW); process.exit(1); }
  if (process.env.NOW) console.log('  (clock overridden: ' + new Date(now).toISOString() + ')\n');
  const today  = jstDay(now);
  const cutoff = {};
  for (const w of Object.keys(WINDOW_DAYS)) cutoff[w] = now - WINDOW_DAYS[w] * DAY_MS;

  // channel id -> accumulator. Keyed by channel so a shared channel is one row
  // however many genmates' files point at it; the first file read wins the
  // slug, so the link lands on a talent page that exists either way.
  const byChannel = new Map();

  for (const fp of files) {
    const data = readJSON(fp);
    if (!data) continue;

    const ch = data.channel || {};
    if (!ch.id) { console.error('  x ' + fp + ': no channel.id'); continue; }

    const branch = path.basename(path.dirname(fp));
    const slug   = path.basename(fp, '.json');

    let t = byChannel.get(ch.id);
    if (!t) {
      t = {
        key: branch + '/' + slug,
        name: CANONICAL[ch.name] || ch.name || slug,
        branch: branch,
        avatar: ch.avatarUrl || '',
        w: {}, top: {},
        _days: new Set(),      // JST day numbers with >= 1 public stream
        _seen: new Set(),      // video ids, so a shared upload is counted once
      };
      for (const w of WINDOWS) { t.w[w] = emptyWindow(); t.top[w] = { m: null, v: null }; }
      byChannel.set(ch.id, t);
    }

    // Views live in a companion file, keyed by video id.
    const views = (readJSON(fp.replace(/\.json$/, '-views.json')) || {}).views || {};

    // Chat totals likewise. Absent for a talent whose streams have not been
    // walked yet, which is not an error — their money boards are just empty.
    const chat = (readJSON(fp.replace(/\.json$/, '-chat.json')) || {}).streams || {};

    for (const v of (data.videos || [])) {
      if (!v.id || t._seen.has(v.id)) continue;
      // Finished public broadcasts only. An upcoming stream has duration 0 and
      // would drag every average down; "unavailable" is a private or deleted
      // video update.js has struck twice; shorts, uploads and the members-only
      // playlist are not public streams.
      if (v.type !== 'stream') continue;
      if (v.status !== 'past') continue;

      const ts = Date.parse(v.published);
      if (!Number.isFinite(ts)) continue;
      t._seen.add(v.id);

      const hours = (v.duration || 0) / 3600;
      const view  = views[v.id] > 0 ? views[v.id] : 0;

      const summary = chat[v.id];
      const paid    = isAnalysed(summary) ? summary : null;
      const yen     = paid ? toYen(paid.cur || {}) : 0;

      // When it started, which is what every page shows. published is the VOD
      // going up, i.e. the end, so a stream that began 25 hours ago and ran
      // three hours still counted as "last 24 hours" by it.
      const start = startMs(v, ts);

      // Streaks count calendar days, not streams, so a day with four streams
      // is one day.
      t._days.add(jstDay(start));

      for (const w of WINDOWS) {
        if (w !== 'all' && start < cutoff[w]) continue;
        const b = t.w[w];
        b.streams++; b.hours += hours; b.views += view;
        if (paid) {
          b.yen     += yen;
          b.sc      += (paid.sc || 0) + (paid.sticker || 0);
          b.members += paid.member || 0;
          b.gifts   += paid.sent   || 0;
        }

        const beatsMoney = yen  > 0 && (!b._m || yen  > b._m.yen);
        const beatsViews = view > 0 && (!b._v || view > b._v.views);
        if (beatsMoney || beatsViews) {
          const entry = {
            id: v.id, title: v.title || '', published: new Date(start).toISOString(),   // when it started
            duration: v.duration || 0, yen: Math.round(yen), views: view,
          };
          if (beatsMoney) b._m = entry;
          if (beatsViews) b._v = entry;
        }
      }
    }
  }

  // ── Finish ───────────────────────────────────────────────────────────────
  const talents = [...byChannel.values()].map(t => {
    t.streak = streaks(t._days, today);

    for (const w of WINDOWS) {
      const b = t.w[w];
      t.top[w] = { m: b._m || null, v: b._v || null };
      // One stream that tops both boards is stored once. The page reads "m" as
      // "same as the money winner" rather than as a second copy of it.
      if (t.top[w].v && t.top[w].m && t.top[w].v.id === t.top[w].m.id) t.top[w].v = 'm';
      delete b._m; delete b._v;
      b.hours = round2(b.hours);
      b.yen   = Math.round(b.yen);
    }
    delete t._days; delete t._seen;
    return t;
  }).sort((a, b) => a.key.localeCompare(b.key));

  const out = {
    lastUpdated: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    talents: talents,
  };
  fs.writeFileSync(OUT, JSON.stringify(out), 'utf8');

  // ── Report ───────────────────────────────────────────────────────────────
  const kb  = (fs.statSync(OUT).size / 1024).toFixed(1);
  const all = talents.reduce((s, t) => ({
    streams: s.streams + t.w.all.streams,
    hours:   s.hours   + t.w.all.hours,
    yen:     s.yen     + t.w.all.yen,
  }), { streams: 0, hours: 0, yen: 0 });

  console.log('  talents          : ' + talents.length);
  console.log('  streams          : ' + all.streams.toLocaleString());
  console.log('  hours            : ' + Math.round(all.hours).toLocaleString());
  console.log('  superchats       : JPY ' + Math.round(all.yen).toLocaleString());
  if (unknownSymbols.size) {
    console.log('\n  ! currencies with no rate (counted as zero):');
    for (const [sym, n] of [...unknownSymbols].sort((a, b) => b[1] - a[1]))
      console.log('      ' + JSON.stringify(sym) + '  x' + n.toLocaleString());
    console.log('    add them to JPY_RATES here AND in the site js/stats.js');
  }
  console.log('\n  ' + OUT + '  ' + kb + ' KB\n');
}

function round2(n) { return Math.round(n * 100) / 100; }

// Longest run of consecutive days in the set, and the run ending now.
//
// "Current" tolerates one day's gap at the end: at 03:00 JST nobody has
// streamed yet today, and a streak that reads 0 every morning and 40 every
// evening is worse than useless. A run that ended two or more days ago is
// genuinely over and reads 0.
function streaks(days, today) {
  if (!days.size) return { cur: 0, max: 0 };
  const sorted = [...days].sort((a, b) => a - b);
  let max = 1, run = 1;
  for (let i = 1; i < sorted.length; i++) {
    run = sorted[i] === sorted[i - 1] + 1 ? run + 1 : 1;
    if (run > max) max = run;
  }
  const last = sorted[sorted.length - 1];
  let cur = 0;
  if (today - last <= 1) {
    cur = 1;
    for (let i = sorted.length - 1; i > 0; i--) {
      if (sorted[i - 1] !== sorted[i] - 1) break;
      cur++;
    }
  }
  return { cur: cur, max: max };
}

main();
