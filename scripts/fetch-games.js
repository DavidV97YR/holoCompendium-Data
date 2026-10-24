'use strict';

// ── The game each stream was played in, where its title doesn't say ─────────
// The site files a stream under the game named in its title's opening bracket
// (【Minecraft】, ◤ VALORANT ◢). Some titles name none: the bracket holds only
// the episode number ("【#3】Hollow Knight: Silksong") or a word for one
// (【#最終回】), or a tag (【ネタバレあり】, 【メン限】), or there is no bracket at
// all. Those streams were filed under "#3", mixing every game's third episode,
// or under nothing. For them the site falls back on the game the streamer
// picked on YouTube (innertube.js streamGame), which this script records.
// Members-only streams are included: YouTube shows their game to anyone.
//
// Only those streams are looked up (about 15,000 of 119,000; the title wins
// everywhere else), each once when first seen and again on each run while it
// is under a week old, so a game the streamer sets or corrects after going
// live is picked up. No quota.
//
// Written into each talent's {slug}-views.json, beside the view counts and the
// music marks; the talent and watch pages already load that file. Only these
// two keys are written, as fetch-music.js writes only "music":
//   "games":        { "<videoId>": "R.E.P.O.", … }   streams that have one
//   "gamesChecked": { "<videoId>": "<ISO time>", … }  every stream looked up
//
// Env: DATA_DIR (default ./data), BUDGET_MIN (stop cleanly, default 25),
//      CONCURRENCY (default 6).

const fs   = require('fs');
const path = require('path');
const { streamGame } = require('./innertube');

const DATA_DIR    = process.env.DATA_DIR || './data';
const BUDGET_MS   = (Number(process.env.BUDGET_MIN) || 25) * 60000;
const CONCURRENCY = Number(process.env.CONCURRENCY) || 6;
const RECHECK_FOR = 7 * 86400000;      // a stream's game is read again while it is this new …
const RECHECK_GAP = 12 * 3600000;      // … at most this often

// When the title already names the game. Mirrors the site's streamCategory
// (holoCompendium js/shared.js: CAT_BRACKETED, CAT_BARRED, CAT_MARKER); a
// stream this calls named is never looked up, so the two must agree on what a
// marker is.
const LEAD   = /^(?:[#＃]\d+\s*)?(?:【([^】]+)】|\[([^\]]+)\]|〖([^〗]+)〗|◤([^◢]+)◢|≪([^≫]+)≫|〘([^〙]+)〙)/;
const BARRED = /^([^│┃【\[〖◤≪〘]{2,30}?)\s*[│┃]/;
const MARKER = /^[#＃]?\s*(?:[0-9０-９]{1,3}|最終回|初回|前編|中編|後編|完結編|(?:part|pt|ep|episode|day)\.?\s*[0-9０-９]+)$/i;
// A bracket that says how the stream is, not what (CAT_TAG, CAT_AGENCY):
// 【ネタバレあり】, 【初見】, 【ゲリラ】, 【縦型配信】, 【メン限】, 【ホロライブ/白上フブキ】.
// The site files those under the game where one is set.
const TAG    = /^[#＃!！\s]*(?:ネタバレ(?:あり|有り?|注意|含む)?|spoilers?(?:\s*(?:alert|warning))?|初見(?:実況|プレイ(?:実況)?)?|完全初見|ゲリラ(?:配信)?|突発(?:配信)?|縦型(?:配信)?|縦配信|メン限|メンバー(?:シップ)?限定(?:配信)?|members?'?s?[\s-]*(?:only|stream|limited)|memberships?(?:[\s-]*only)?)[!！\s]*$/i;
const AGENCY = /^(?:ホロライブ|hololive|ぶいすぽっ?[!！]?|vspo[!！]?)$/i;
const isTag  = c => TAG.test(c) || (/[\/／]/.test(c) && c.split(/[\/／]/).some(p => AGENCY.test(p.trim())));
function titleNamesGame(title) {
  const t = String(title || '').trim();
  const m = t.match(LEAD) || t.match(BARRED);
  const c = m ? (m[1] || m[2] || m[3] || m[4] || m[5] || m[6] || '').replace(/\s+/g, ' ').trim() : '';
  return !!c && !MARKER.test(c) && !isTag(c);
}

// Public streams, and members-only ones (the members playlist's items with a
// real start; its uploads have none).
const isStream = v => v.type === 'stream' || (v.type === 'member' && Number.isFinite(Date.parse(v.actualStart)));

function streamStartMs(v) {
  return Date.parse(v.actualStart) || Date.parse(v.published) || 0;
}

// Every talent file, grouped by channel: genmates who share one (FUWAMOCO,
// the mekPark units) each keep a views file, and each gets the same games.
function channels() {
  const groups = new Map();
  for (const branch of fs.readdirSync(DATA_DIR)) {
    const dir = path.join(DATA_DIR, branch);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json') || /-(chat|views)\.json$/.test(name)) continue;
      const file = path.join(dir, name);
      let doc;
      try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      const id = doc && doc.channel && doc.channel.id;
      if (!id || !Array.isArray(doc.videos)) continue;
      if (!groups.has(id)) groups.set(id, { name: doc.channel.name || name, files: [], videos: doc.videos });
      groups.get(id).files.push(file);
    }
  }
  return groups;
}

function readViews(file) {
  try { return JSON.parse(fs.readFileSync(file.replace(/\.json$/, '-views.json'), 'utf8')); }
  catch { return null; }
}

async function main() {
  const started = Date.now();
  const groups = channels();

  // What to look up, across every channel, oldest check first.
  const jobs = [];
  for (const [channelId, g] of groups) {
    const doc = readViews(g.files[0]) || {};
    const checked = doc.gamesChecked || {};
    for (const v of g.videos) {
      if (!isStream(v) || v.status === 'upcoming' || v.status === 'live' || v.status === 'unavailable') continue;
      if (titleNamesGame(v.title)) continue;
      const at = Date.parse(checked[v.id]) || 0;
      const young = started - streamStartMs(v) < RECHECK_FOR;
      if (at && !(young && started - at > RECHECK_GAP)) continue;
      jobs.push({ channelId, id: v.id, at });
    }
  }
  jobs.sort((a, b) => a.at - b.at);
  console.log(`${groups.size} channels, ${jobs.length} stream(s) to look up`);

  const found = new Map();       // channelId -> Map(videoId -> { game } )
  let next = 0, done = 0, failed = 0, withGame = 0, stopped = false;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < jobs.length) {
      if (Date.now() - started > BUDGET_MS) { stopped = true; return; }
      const j = jobs[next++];
      const r = await streamGame(j.id);
      if (r.failed) { failed++; continue; }
      if (!found.has(j.channelId)) found.set(j.channelId, new Map());
      found.get(j.channelId).set(j.id, r.game);
      done++;
      if (r.game) withGame++;
    }
  }));

  // Written per talent file, read fresh so nothing another step wrote to it
  // this run (the music marks) is lost.
  const now = new Date().toISOString();
  let files = 0;
  for (const [channelId, res] of found) {
    const g = groups.get(channelId);
    for (const file of g.files) {
      const vp = file.replace(/\.json$/, '-views.json');
      const doc = readViews(file) || { channelId, channelName: g.name, lastUpdated: now, views: {} };
      const games = doc.games || {}, checked = doc.gamesChecked || {};
      let changed = false;
      for (const [id, game] of res) {
        if (game && games[id] !== game) { games[id] = game; changed = true; }
        if (!game && id in games) { delete games[id]; changed = true; }   // taken off since
        checked[id] = now;
      }
      doc.games = games;
      doc.gamesChecked = checked;
      fs.writeFileSync(vp, JSON.stringify(doc, null, 2), 'utf8');
      files++;
      if (changed) console.log('  ✓ ' + path.relative(DATA_DIR, vp));
    }
  }

  console.log(`\n${done} looked up in ${Math.round((Date.now() - started) / 1000)}s, ${withGame} with a game, `
            + `${failed} failed (tried again next run), ${files} file(s) written`
            + (stopped ? `, stopped at the ${BUDGET_MS / 60000}-minute budget with ${jobs.length - next} left for the next run` : ''));
}

main().catch(e => { console.error(e); process.exit(1); });
