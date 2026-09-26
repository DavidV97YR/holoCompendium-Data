'use strict';

// ── Quick new-video watcher (every 30 minutes) ──────────────────────────────
// Reads each channel's uploads feed and members feed and compares them with
// what is already saved. Nothing new → nothing else happens, so a quiet run
// is two small requests per channel. Anything new is identified by innertube
// (./innertube.js) — Short, stream, video or members — and saved at once,
// with its real start time if it is live or finished.
//
// It only ever ADDS videos. Everything else (titles, durations, status
// changes) stays with update.js, which treats anything this adds as known.
//
// The type it saves is the ground truth: records carry typedBy "innertube",
// and the Full Recheck never re-sorts those between stream, video and Short
// (see update.js). A video innertube is bot-checked on is looked up through the
// official Data API instead and saved as typedBy "data-api", without that lock.
// It is not asked again: from GitHub innertube is bot-checked on every video
// that is already playable, so retrying never answered (11 waiting, not one
// confirmed), and it only slowed the run — 34s to 67s in a morning. The Full
// Recheck reads the same API and lists, so it keeps those types right. One
// neither can settle is not saved, so the next run, five minutes later, tries
// it again.

const fs   = require('fs');
const path = require('path');
const { classify } = require('./innertube');

const DATA_DIR = process.env.DATA_DIR || './data';
const pause = ms => new Promise(r => setTimeout(r, ms));

function decodeHtmlEntities(str) {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// Same parse as update.js's fetchRSS. A channel with no members feed answers
// 404, which is simply an empty list.
async function feed(playlistId) {
  const r = await fetch('https://www.youtube.com/feeds/videos.xml?playlist_id=' + playlistId);
  if (r.status === 404) return [];
  if (!r.ok) throw new Error('RSS HTTP ' + r.status + ' for ' + playlistId);
  const body = await r.text();
  const out = [];
  for (const m of body.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const id = m[1].match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
    const t  = m[1].match(/<title>([^<]+)<\/title>/);
    const p  = m[1].match(/<published>([^<]+)<\/published>/);
    if (id) out.push({ id: id[1].trim(), title: t ? decodeHtmlEntities(t[1].trim()) : '', published: p ? p[1].trim() : '' });
  }
  return out;
}

// The official Data API's view of one video, for when innertube is bot-checked.
// 1 quota unit, spent only on a video innertube could not identify, and only
// until it has been saved. `broadcast` means it has liveStreamingDetails: a
// stream (or a premiere, which the Full Recheck sorts out — these records are
// not locked).
async function dataApiClassify(id) {
  const key = process.env.YT_API_KEY;
  if (!key) return { unidentified: 'no YT_API_KEY' };
  const qs = new URLSearchParams({ part: 'snippet,contentDetails,liveStreamingDetails', id, key });
  const r = await fetch('https://www.googleapis.com/youtube/v3/videos?' + qs);
  if (!r.ok) return { unidentified: 'HTTP ' + r.status };
  const item = ((await r.json()).items || [])[0];
  if (!item) return { unidentified: 'not returned (private or deleted)' };
  const live = item.liveStreamingDetails || null;
  const d = (item.contentDetails && item.contentDetails.duration || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  const iso = t => { const ms = Date.parse(t); return Number.isFinite(ms) ? new Date(ms).toISOString() : ''; };
  let status = 'past';
  if (live && live.actualStartTime && !live.actualEndTime) status = 'live';
  else if (live && !live.actualStartTime)                   status = 'upcoming';
  return {
    title:     (item.snippet && item.snippet.title) || '',
    published: iso(item.snippet && item.snippet.publishedAt),
    type:      live ? 'stream' : 'video',
    broadcast: !!live,
    duration:  d ? (+d[1] || 0) * 3600 + (+d[2] || 0) * 60 + (+d[3] || 0) : 0,
    status,
    ...(live && live.scheduledStartTime ? { scheduledStart: iso(live.scheduledStartTime) } : {}),
    ...(live && live.actualStartTime    ? { actualStart:    iso(live.actualStartTime) }    : {}),
  };
}

// Every talent file, grouped by channel. Talents who share a channel (the
// mekPark units, FUWAMOCO) each keep their own copy of its video list, so a
// new video has to reach every file in the group.
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
      if (!groups.has(id)) groups.set(id, { name: doc.channel.name || name, files: [] });
      groups.get(id).files.push({ file, doc });
    }
  }
  return groups;
}

async function main() {
  const started = Date.now();
  const groups = channels();
  let added = 0, skipped = 0, failed = 0;

  for (const [channelId, group] of groups) {
    const suffix = channelId.replace(/^UC/, '');
    const known  = new Set(group.files.flatMap(f => f.doc.videos.map(v => v.id)));

    let uploads, members;
    try {
      [uploads, members] = await Promise.all([feed('UU' + suffix), feed('UUMO' + suffix)]);
    } catch (e) {
      console.log(`  ⚠ ${group.name}: ${e.message}`); failed++; continue;
    }
    const memberIds = new Set(members.map(e => e.id));
    const fresh = [...uploads, ...members].filter((e, i, a) => !known.has(e.id) && a.findIndex(x => x.id === e.id) === i);
    if (!fresh.length) continue;

    const records = [];
    let lists = null;                     // Videos / Shorts feeds, fetched only if the fallback needs them
    for (const entry of fresh) {
      let info = null;
      try { info = await classify(entry.id); } catch (e) { info = { unidentified: e.message }; }
      let typedBy = 'innertube';
      if (info.unidentified) {
        // Innertube is bot-checked from GitHub's addresses on every video that
        // is already playable — anything but a stream that has not started.
        // The official Data API is never bot-checked. It cannot
        // tell a Short from a video, so the Shorts and Videos feeds settle
        // that, and the result is saved WITHOUT the innertube lock: the Full
        // Recheck can still correct it.
        const fb = await dataApiClassify(entry.id).catch(e => ({ unidentified: e.message }));
        if (fb.unidentified) {
          console.log(`  … ${group.name}: ${entry.id} not identifiable this time (${info.unidentified}; API: ${fb.unidentified}) — retried next run`);
          skipped++; continue;
        }
        if (!fb.broadcast) {
          if (!lists) {
            const [v, s] = await Promise.all([feed('UULF' + suffix).catch(() => []), feed('UUSH' + suffix).catch(() => [])]);
            lists = { videos: new Set(v.map(e => e.id)), shorts: new Set(s.map(e => e.id)) };
          }
          if (lists.shorts.has(entry.id))      fb.type = 'short';
          else if (lists.videos.has(entry.id)) fb.type = 'video';
          else {                               // an upload in neither list yet: wait rather than guess
            console.log(`  … ${group.name}: ${entry.id} not in the Videos or Shorts list yet — retried next run`);
            skipped++; continue;
          }
        }
        info = fb;
        typedBy = 'data-api';
      }
      // The members feed is YouTube's own list of members content; it wins.
      if (memberIds.has(entry.id)) info.type = 'member';
      records.push({
        id:        entry.id,
        title:     info.title || entry.title,
        published: info.published || entry.published,
        type:      info.type,
        duration:  info.duration,
        status:    info.status,
        ...(info.scheduledStart ? { scheduledStart: info.scheduledStart } : {}),
        ...(info.actualStart    ? { actualStart:    info.actualStart }    : {}),
        typedBy,
      });
      console.log(`  + ${group.name}: [${info.type}${info.status !== 'past' ? ', ' + info.status : ''}]${typedBy === 'innertube' ? '' : ' (via API)'} ${entry.id} ${(info.title || entry.title).slice(0, 50)}`);
      await pause(250);
    }
    if (!records.length) continue;

    for (const { file, doc } of group.files) {
      const have = new Set(doc.videos.map(v => v.id));
      for (const r of records) if (!have.has(r.id)) doc.videos.push({ ...r });
      // Same save as update.js: newest first, count and timestamp refreshed.
      doc.videos.sort((a, b) => new Date(b.published) - new Date(a.published));
      doc.videoCount  = doc.videos.length;
      doc.lastUpdated = new Date().toISOString();
      fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8');
    }
    added += records.length;
  }

  console.log(`\n${groups.size} channels checked in ${((Date.now() - started) / 1000).toFixed(1)}s — `
            + `${added} new video(s) added, ${skipped} to retry next run, ${failed} feed failure(s)`);
}

main().catch(e => { console.error(e); process.exit(1); });
