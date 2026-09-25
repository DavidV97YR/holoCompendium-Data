#!/usr/bin/env node

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { classify } = require('./innertube');

// One-time repair list (scripts/type-restore.json): videos an older Full
// Recheck relabelled "stream" after they went private, deleted or unlisted,
// with the type they had while public, recovered from the repo's history.
// An entry only applies while the video still has its "from" type, so it is
// idempotent, and the file can be deleted once every entry has been applied.
const TYPE_RESTORE = (() => {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(__dirname, 'type-restore.json'), 'utf8'));
    return new Map((doc.restore || []).map(e => [e.id, e]));
  } catch { return new Map(); }
})();

// ── helpers ───────────────────────────────────────────────────────────────────

// Certificates are verified. This used to be off for every run, CI included,
// so calls carrying the Holodex and YouTube keys never checked who answered.
// A local dev proxy that re-signs traffic can still switch it off explicitly.
const agent = new https.Agent({ rejectUnauthorized: process.env.ALLOW_INSECURE_TLS !== '1' });

// No request may hang the run: a stalled socket used to hold the whole
// updater, and GitHub's default job limit is six hours.
const REQUEST_TIMEOUT_MS = 60000;

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const opts = { headers };
    if (url.startsWith('https')) opts.agent = agent;
    const req = client.get(url, opts, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return get(new URL(res.headers.location, url).href, headers).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('timed out after ' + REQUEST_TIMEOUT_MS / 1000 + 's')));
  });
}

/**
 * Google bot-gates the shared Actions runner IPs and answers a slice of
 * requests with 401. It is the address asking that gets refused, not the sheet
 * or the secret, and it varies per attempt — so a retry a few seconds later
 * normally lands. Same helper fetch-chat.js uses.
 */
async function getWithRetry(url, attempts) {
  const max = attempts || 3;
  let last = null;
  for (let i = 1; i <= max; i++) {
    try {
      const r = await get(url);
      if (r.status === 200) return r;
      last = r;
      console.log(`  ⚠ CSV fetch attempt ${i}: HTTP ${r.status}`);
    } catch (e) {
      last = { status: 0, body: e.message };
      console.log(`  ⚠ CSV fetch attempt ${i}: ${e.message}`);
    }
    if (i < max) await new Promise(r => setTimeout(r, i * 3000));
  }
  return last;
}

function head(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const opts = { method: 'HEAD' };
    if (url.startsWith('https')) opts.agent = agent;
    const parsed = new URL(url);
    opts.hostname = parsed.hostname;
    opts.path = parsed.pathname + parsed.search;
    const req = client.request(opts, res => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('timed out')));
    req.end();
  });
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map((line, i) => {
    const cols = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    const row = { _row: i + 2 };
    headers.forEach((h, j) => row[h] = cols[j] || '');
    return row;
  });
}

function slugify(name) {
  return name.toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function parseRows(rowsRaw, allRows) {
  if (!rowsRaw || rowsRaw.toLowerCase() === 'all') return allRows;
  const rowNums = new Set();
  for (const part of rowsRaw.split(',')) {
    const range = part.trim().match(/^(\d+)-(\d+)$/);
    if (range) {
      for (let i = parseInt(range[1]); i <= parseInt(range[2]); i++) rowNums.add(i);
    } else {
      rowNums.add(parseInt(part.trim()));
    }
  }
  return allRows.filter(r => rowNums.has(r._row));
}

function decodeHtmlEntities(str) {
  return str.replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'");
}

// ── YouTube Data API (fallback for dead avatars) ─────────────────────────

async function ytApiFetchBranding(channelId, apiKey) {
  const qs = new URLSearchParams({ part: 'snippet,brandingSettings', id: channelId, key: apiKey }).toString();
  const url = `https://www.googleapis.com/youtube/v3/channels?${qs}`;
  const { status, body } = await get(url);
  if (status !== 200) throw new Error(`YouTube API ${status}: ${body.slice(0, 200)}`);
  const data = JSON.parse(body);
  const item = data.items?.[0];
  const thumb = item?.snippet?.thumbnails;
  const rawAvatar = thumb?.high?.url || thumb?.medium?.url || thumb?.default?.url || '';
  const rawBanner = item?.brandingSettings?.image?.bannerExternalUrl || '';
  return {
    avatarUrl: rawAvatar.replace(/=s\d+.*$/, ''),
    bannerUrl: rawBanner ? `${rawBanner}=s0` : '',
  };
}

// ── YouTube Data API: full video detail (used by backfill) ───────────────

function parseIsoDuration(iso) {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}

// Derive a stream's lifecycle state from YouTube liveStreamingDetails.
function deriveLiveStatus(live) {
  if (!live)                   return 'past';     // normal upload — never a broadcast
  if (live.actualEndTime)      return 'past';     // broadcast/premiere finished
  if (live.actualStartTime)    return 'live';     // currently airing
  if (live.scheduledStartTime) return 'upcoming'; // scheduled, not started yet
  return 'past';
}

// Start times arrive as "…:07Z" from the Data API and "…:07.000Z" from Holodex
// and innertube. Stored one way (toISOString) and compared as instants, or the
// Full Recheck and the Updater rewrote each other's copy of the same moment on
// every run — a needless commit each time.
function isoTime(t) { const ms = Date.parse(t); return Number.isFinite(ms) ? new Date(ms).toISOString() : ''; }
function sameTime(a, b) { return Date.parse(a) === Date.parse(b); }

// Batch up to 50 IDs per call (1 quota unit each)
// → { id: { title, published, duration, status, scheduledStart, actualStart } }
async function fetchYouTubeVideoDetails(videoIds, apiKey) {
  const out = {};
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const qs = new URLSearchParams({ part: 'snippet,contentDetails,liveStreamingDetails', id: batch.join(','), key: apiKey }).toString();
    const url = `https://www.googleapis.com/youtube/v3/videos?${qs}`;
    const { status, body } = await get(url);
    if (status !== 200) throw new Error(`YouTube API ${status}: ${body.slice(0, 200)}`);
    const data = JSON.parse(body);
    for (const item of (data.items || [])) {
      const live = item.liveStreamingDetails;
      out[item.id] = {
        title:          item.snippet?.title || '',
        published:      item.snippet?.publishedAt || '',
        duration:       parseIsoDuration(item.contentDetails?.duration),
        status:         deriveLiveStatus(live),
        scheduledStart: isoTime(live?.scheduledStartTime),
        // When the broadcast really began. `published` is not it — for a stream
        // that is when the VOD was posted, the END plus ~17 minutes — and the
        // schedule can be a stale waiting room. Already in this response, so
        // keeping it costs no quota.
        actualStart:    isoTime(live?.actualStartTime),
        // Whether it was ever a broadcast at all. A stream always carries
        // liveStreamingDetails; an upload never does.
        broadcast:      !!live,
      };
    }
    if (i + 50 < videoIds.length) await new Promise(r => setTimeout(r, 150));
  }
  return out;
}

// Fully paginated playlistItems fetch — same technique bootstrap.js uses to
// derive `type` on day one. Unlike the RSS feeds (capped at ~15 most recent
// entries, and just a public XML scrape that can occasionally drop entries),
// this walks the entire playlist via nextPageToken and is authoritative.
// Costs 1 quota unit per page of up to 50 items.
async function fetchYouTubePlaylistItemIds(playlistId, apiKey) {
  const ids = [];
  let pageToken = '';
  do {
    const params = { part: 'contentDetails', playlistId, maxResults: 50 };
    if (pageToken) params.pageToken = pageToken;
    const qs = new URLSearchParams({ ...params, key: apiKey }).toString();
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?${qs}`;
    const { status, body } = await get(url);
    if (status !== 200) {
      if (/"reason":\s*"playlistNotFound"/.test(body)) return ids; // channel has none of this type
      throw new Error(`YouTube API ${status}: ${body.slice(0, 200)}`);
    }
    const data = JSON.parse(body);
    for (const item of (data.items || [])) ids.push(item.contentDetails?.videoId);
    pageToken = data.nextPageToken || '';
    if (pageToken) await new Promise(r => setTimeout(r, 150));
  } while (pageToken);
  return ids;
}

// ── RSS ───────────────────────────────────────────────────────────────────────

async function fetchRSS(playlistId) {
  const url = `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlistId}`;
  const { status, body } = await get(url);
  if (status !== 200) throw new Error(`RSS HTTP ${status} for ${playlistId}`);
  if (!body.includes('<feed')) throw new Error(`No feed returned for ${playlistId}`);

  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(body)) !== null) {
    const block = match[1];
    const idMatch        = block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
    const titleMatch     = block.match(/<title>([^<]+)<\/title>/);
    const publishedMatch = block.match(/<published>([^<]+)<\/published>/);
    if (idMatch) entries.push({
      id:        idMatch[1].trim(),
      title:     titleMatch     ? decodeHtmlEntities(titleMatch[1].trim())     : '',
      published: publishedMatch ? publishedMatch[1].trim() : '',
    });
  }
  return entries;
}

// ── Holodex ───────────────────────────────────────────────────────────────────

// Holodex allows 80 requests per 2 minutes = 1 request per 1500ms to stay safe
const holodexQueue = { last: 0, interval: 1500 };
function holodexThrottle() {
  const now = Date.now();
  const wait = Math.max(0, holodexQueue.last + holodexQueue.interval - now);
  holodexQueue.last = now + wait;
  return new Promise(r => setTimeout(r, wait));
}

async function holodexGet(apiKey, endpoint) {
  await holodexThrottle();
  const url = `https://holodex.net/api/v2${endpoint}`;
  const { status, body } = await get(url, { 'X-APIKEY': apiKey });
  if (status !== 200) throw new Error(`Holodex API ${status}: ${body.slice(0, 200)}`);
  return JSON.parse(body);
}

async function fetchHolodexChannel(channelId, apiKey) {
  return holodexGet(apiKey, `/channels/${channelId}`);
}

// The newest `maxPages` pages (50 each) of a channel's videos. The title and
// duration sync only needs recent ones: it used to page through every video
// of every channel on every run — ~2,000 requests at 1.5 s each, most of the
// 70-minute runtime — to re-read archives that never change. The Full Recheck
// re-reads the whole catalogue from YouTube twice a day anyway.
async function fetchHolodexVideos(channelId, apiKey, maxPages = 2) {
  const videos = [];
  let offset = 0;
  const limit = 50;
  for (let page = 0; page < maxPages; page++) {
    const data = await holodexGet(apiKey, `/channels/${channelId}/videos?limit=${limit}&offset=${offset}&type=stream,clip`);
    const items = Array.isArray(data) ? data : data.items || [];
    videos.push(...items);
    if (items.length < limit) break;
    offset += limit;
  }
  return videos;
}

async function fetchHolodexVideoDetail(videoId, apiKey) {
  return holodexGet(apiKey, `/videos/${videoId}`);
}

// ── core update logic ─────────────────────────────────────────────────────────

async function updateChannel(talent, holodexKey, dataDir, backfill = false) {
  const { Name, Branch, 'Channel ID': channelId } = talent;
  const slug = slugify(Name);
  const filePath = path.join(dataDir, Branch.toLowerCase(), `${slug}.json`);

  if (!fs.existsSync(filePath)) {
    console.log(`  ⚠ No JSON found for ${Name} — run bootstrap first`);
    return { name: Name, status: 'missing' };
  }

  const local = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  let changed = false;

  for (const lv of local.videos) {
    const fix = TYPE_RESTORE.get(lv.id);
    if (fix && lv.type === fix.from) {
      console.log(`    ↻ Type restore [${lv.id}]: ${lv.type} → ${fix.to} (from history)`);
      lv.type = fix.to;
      changed = true;
    }
  }

  // Collapse any video listed twice, keeping whichever copy has more filled in.
  // Done on load so the rest of the run only ever sees one entry per id — the
  // Holodex title/duration sync below builds an id→video map, which silently
  // drops all but the last copy and leaves the others to drift stale.
  const byId = new Map();
  const score = v => (v.duration ? 2 : 0) + (v.status ? 1 : 0);
  // What either copy knows is kept: the watcher's type lock and the start
  // times live on whichever copy it saved, and the fuller copy winning used to
  // drop them when this job and watch-new.js both added the same new video.
  const KEEP = ['typedBy', 'actualStart', 'scheduledStart'];
  for (const v of local.videos) {
    const prev = byId.get(v.id);
    if (!prev) { byId.set(v.id, v); continue; }
    const [win, lose] = score(v) > score(prev) ? [v, prev] : [prev, v];
    for (const k of KEEP) if (lose[k] && !win[k]) win[k] = lose[k];
    if (lose.typedBy === 'innertube') { win.type = lose.type; win.typedBy = 'innertube'; }
    byId.set(v.id, win);
  }
  if (byId.size !== local.videos.length) {
    console.log(`  ⚠ removed ${local.videos.length - byId.size} duplicate(s)`);
    local.videos = [...byId.values()];
    changed = true;
  }

  // Drop the stored thumbnail URL. It is always
  // https://i.ytimg.com/vi/<id>/maxresdefault.jpg, which the site rebuilds from
  // the id it already has (thumbCard()), so storing it costs ~16% of every
  // payload to say nothing. Stripped on load so existing records shed it too.
  for (const v of local.videos) {
    if (v.thumbnail !== undefined) { delete v.thumbnail; changed = true; }
    // Holodex has statuses of its own ("new" for a video it has not processed
    // yet, "missing"), and the old new-video path stored them verbatim. The
    // site knows past / live / upcoming / unavailable only.
    if (v.status !== undefined && !['past', 'live', 'upcoming', 'unavailable'].includes(v.status)) {
      v.status = 'past'; changed = true;
    }
  }
  // A count that no longer matches the list (left by a text merge of two jobs'
  // commits) is corrected by the save below.
  if (local.videoCount !== local.videos.length) changed = true;

  // Use channel ID from JSON — already resolved to UC... by bootstrap
  const resolvedId = local.channel.id;
  const suffix = resolvedId.replace(/^UC/, '');

  // ── 1. RSS: the uploads feed, for the date sync in step 2 ─────────────────
  // New videos are not added here any more. watch-new.js checks the feeds every
  // five minutes and identifies each one by innertube (or the Data API), which
  // this run could only guess at: a video in no Videos / Shorts / Members feed
  // was called a "stream", so a feed that failed to load, or had not caught up
  // with a brand-new upload yet, turned Shorts and videos into streams.
  console.log(`  [${Name}] Fetching RSS feed...`);
  const feeds = { UU: [] };
  try {
    feeds.UU = await fetchRSS(`UU${suffix}`);
  } catch(e) {
    console.log(`    ⚠ RSS UU failed: ${e.message}`);
  }
  await new Promise(r => setTimeout(r, 500));

  // ── 1b. Backfill (heavy pass): re-enrich EVERY existing video ─────────────
  // Normal runs only touch new videos + the 15 most recent. Backfill re-checks the
  // whole catalog against authoritative YouTube data so schema additions and any
  // drift in title/duration/published/type reach old records too. Opt-in via
  // checkbox (manual runs) or the scheduled Full Recheck workflow.
  if (backfill) {
    const ytKey = process.env.YT_API_KEY;
    if (!ytKey) {
      console.log(`    ⚠ Backfill requested but YT_API_KEY is not set — skipping backfill`);
    } else {
      const allIds = local.videos.map(v => v.id);
      // What YouTube returned, kept for the type pass below: a video missing
      // from it is private or deleted, which that pass has to know.
      let ytDetails = null;
      console.log(`  [${Name}] Backfill: re-enriching ${allIds.length} video(s) via YouTube API...`);
      try {
        const details = await fetchYouTubeVideoDetails(allIds, ytKey);
        ytDetails = details;
        let fixed = 0;
        for (const lv of local.videos) {
          const d = details[lv.id];
          if (!d) continue; // deleted / private — leave existing record untouched
          if (d.title && d.title !== lv.title) { lv.title = d.title; changed = true; fixed++; }
          if (d.published && new Date(d.published).getTime() !== new Date(lv.published).getTime()) {
            lv.published = d.published; changed = true; fixed++;
          }
          if (d.duration && d.duration !== lv.duration) { lv.duration = d.duration; changed = true; fixed++; }
          if (d.status && d.status !== lv.status) { lv.status = d.status; changed = true; fixed++; }
          if (d.scheduledStart && !sameTime(d.scheduledStart, lv.scheduledStart)) { lv.scheduledStart = d.scheduledStart; changed = true; fixed++; }
          if (d.actualStart && !sameTime(d.actualStart, lv.actualStart)) { lv.actualStart = d.actualStart; changed = true; fixed++; }
        }
        console.log(`    ✓ Backfill applied ${fixed} field update(s) across ${allIds.length} video(s)`);
      } catch(e) {
        console.log(`    ⚠ Backfill failed: ${e.message}`);
      }

      // ── 1b-ii. Backfill: reclassify `type` via playlistItems ────────────
      // The Data API's /videos endpoint (used just above) has no "isShort"
      // field, so that pass alone can never fix `type` — this closes that
      // gap using the same full-catalog set-membership technique
      // bootstrap.js already relies on, instead of the ~15-item-capped RSS
      // feeds normal runs use.
      console.log(`  [${Name}] Backfill: reclassifying type via playlistItems...`);
      try {
        const [ytVideoIds, ytShortIds, ytMemberIds] = await Promise.all([
          fetchYouTubePlaylistItemIds(`UULF${suffix}`, ytKey),
          fetchYouTubePlaylistItemIds(`UUSH${suffix}`, ytKey),
          fetchYouTubePlaylistItemIds(`UUMO${suffix}`, ytKey),
        ]);
        const videoSet  = new Set(ytVideoIds);
        const shortSet  = new Set(ytShortIds);
        const memberSet = new Set(ytMemberIds);

        let typeFixed = 0;
        for (const lv of local.videos) {
          // Elimination, same order bootstrap.js uses: video < short < member.
          // Anything already in our catalog that matches none of the three
          // specialty playlists is a regular stream by definition.
          let trueType = 'stream';
          if (videoSet.has(lv.id))  trueType = 'video';
          if (shortSet.has(lv.id))  trueType = 'short';
          if (memberSet.has(lv.id)) trueType = 'member';
          // "In none of the three playlists" only means "stream" for a video
          // YouTube still shows. A private or deleted one drops out of every
          // playlist too, so elimination turned each privated Short and video
          // into a "stream" on the next recheck — Kikirara Vivi's 17-second
          // MARIO KART DANCE among them. With no evidence, keep the type it had.
          if (trueType === 'stream' && (!ytDetails || !ytDetails[lv.id])) continue;
          // Nor for a video YouTube does return but that was never a broadcast:
          // an unlisted upload sits in none of the playlists either, and that is
          // how Koganei Niko's still-public 37-second Short stayed a "stream".
          if (trueType === 'stream' && !ytDetails[lv.id].broadcast) continue;
          // Identified by innertube when it went up (watch-new.js): that is the
          // ground truth for stream / video / Short, and elimination never
          // overrides it. Moving into or out of members-only is a real change a
          // talent makes (a members stream opened to everyone), so that one is
          // still followed — from the members list, and only while YouTube still
          // shows the video, so a private one is never touched.
          if (lv.typedBy === 'innertube') {
            const visible = !!ytDetails[lv.id];
            if (!visible) continue;
            if (memberSet.has(lv.id))        trueType = 'member';
            else if (lv.type === 'member')   trueType = ytDetails[lv.id].broadcast ? 'stream'
                                                      : shortSet.has(lv.id) ? 'short' : 'video';
            else                             continue;
          }
          if (trueType !== lv.type) {
            console.log(`    ↻ Type fix [${lv.id}]: ${lv.type} → ${trueType}`);
            lv.type = trueType;
            changed = true;
            typeFixed++;
          }
        }
        console.log(`    ✓ Reclassified ${typeFixed} video(s)`);
      } catch(e) {
        console.log(`    ⚠ Type reclassification failed: ${e.message}`);
      }

      // ── 1b-iii. Repair: private "streams" the old elimination mislabelled ─
      // Those records can no longer be asked of YouTube, but Holodex still
      // knows them: a Short carries topic "shorts", and a real stream carries
      // its start time (saved as actualStart, which also takes it out of this
      // pass for good). Asked once each; typeChecked marks the ones Holodex
      // could not settle, so they are not asked again every day.
      if (ytDetails) {
        // Only the old guessed records. A stream the watcher identified, by
        // innertube or through the Data API when innertube was bot-checked, is
        // a stream, private or not: Holodex is never asked about it.
        const suspects = local.videos.filter(v => v.type === 'stream' && !ytDetails[v.id]
          && !v.typedBy && !v.actualStart && !v.typeChecked).slice(0, 40);
        let repaired = 0;
        for (const lv of suspects) {
          try {
            const hd = await fetchHolodexVideoDetail(lv.id, holodexKey);
            if (hd.start_actual)              { lv.actualStart = isoTime(hd.start_actual); }
            else if (hd.topic_id === 'shorts') { lv.type = 'short'; repaired++;
                                                 console.log(`    ↻ Type repair [${lv.id}]: stream → short (private; Holodex topic shorts)`); }
            else                               { lv.typeChecked = true; }
          } catch (e) {
            if (/(^|\D)404(\D|$)/.test(e.message)) lv.typeChecked = true;   // Holodex never had it
            else continue;                                                      // transient — try again next run
          }
          changed = true;
        }
        if (suspects.length) console.log(`    ✓ Checked ${suspects.length} private stream(s) against Holodex, ${repaired} were Shorts`);
      }
    }
  }

  // ── 1c. Status re-check (incremental, Holodex) ────────────────────────────
  // Re-check only the few still-pending (upcoming/live) streams so they flip
  // upcoming → live → past once they air, and so deletions are caught. No
  // YouTube, no full-catalog scan — just one (throttled) Holodex call each.
  // Holodex `missing` = removed/privated → `unavailable` (after 2 strikes, so a
  // transient blip doesn't wrongly hide a real waiting room). YouTube stays in
  // Backfill only.
  if (!backfill) {
    const pending = local.videos.filter(v => v.status === 'upcoming' || v.status === 'live');
    if (pending.length) {
      console.log(`  [${Name}] Re-checking ${pending.length} upcoming/live stream(s) via Holodex...`);
      for (const lv of pending) {
        let hstatus = null, detail = null;
        try {
          detail  = await fetchHolodexVideoDetail(lv.id, holodexKey);
          hstatus = detail.status || null;
        } catch(e) {
          if (/(^|\D)404(\D|$)/.test(e.message)) hstatus = 'missing'; // gone from Holodex
          else { console.log(`    ⚠ Re-check failed for ${lv.id}: ${e.message}`); continue; }
        }

        if (hstatus === 'missing') {
          // Holodex also drops streams YouTube still shows: free chat rooms,
          // a waiting room left unused. Marking those unavailable here while
          // the Full Recheck (which asks YouTube) set them back to upcoming
          // flipped them between hidden and shown twice a day. YouTube decides:
          // still there → its status; private or removed → unavailable now.
          // Only when innertube is bot-checked does the two-miss rule apply.
          const yt = await classify(lv.id).catch(e => ({ unidentified: 'error: ' + e.message }));
          if (!yt.unidentified) {
            if (lv.missStreak) { delete lv.missStreak; changed = true; }
            if (yt.status && yt.status !== lv.status) {
              console.log(`    ↻ ${lv.id}: ${lv.status} → ${yt.status} (YouTube; Holodex no longer lists it)`);
              lv.status = yt.status; changed = true;
            }
            if (yt.actualStart && !sameTime(yt.actualStart, lv.actualStart)) { lv.actualStart = yt.actualStart; changed = true; }
            if (yt.duration && !lv.duration) { lv.duration = yt.duration; changed = true; }
            continue;
          }
          if (/private|removed|unavailable|terminated|deleted|no longer/i.test(yt.unidentified)) {
            lv.status = 'unavailable'; delete lv.missStreak; changed = true;
            console.log(`    ✕ unavailable: ${lv.id} (YouTube: ${yt.unidentified})`);
            continue;
          }
          lv.missStreak = (lv.missStreak || 0) + 1;
          if (lv.missStreak >= 2) { lv.status = 'unavailable'; delete lv.missStreak; }
          changed = true;
          console.log(`    ${lv.status === 'unavailable' ? '✕ unavailable' : `… missing (${lv.missStreak}/2)`}: ${lv.id}`);
          continue;
        }

        if (lv.missStreak) { delete lv.missStreak; changed = true; } // recovered

        if (hstatus && hstatus !== lv.status && ['upcoming', 'live', 'past'].includes(hstatus)) {
          console.log(`    ↻ ${lv.id}: ${lv.status} → ${hstatus}`);
          lv.status = hstatus;
          changed = true;
        }
        const sched = (detail.start_scheduled || detail.available_at || '');
        if (sched && !sameTime(sched, lv.scheduledStart)) { lv.scheduledStart = isoTime(sched); changed = true; }
        // Holodex fills start_actual the moment a stream goes live, so this
        // catches it on the pass that sees upcoming → live.
        if (detail.start_actual && !sameTime(detail.start_actual, lv.actualStart)) { lv.actualStart = isoTime(detail.start_actual); changed = true; }
      }
    }
  }

  // ── 2. RSS date sync: fix published dates for the 15 most recent entries ──
  const rssMap = Object.fromEntries(feeds.UU.map(e => [e.id, e]));
  const recentLocal = local.videos.slice(0, 15);
  for (const lv of recentLocal) {
    const rssEntry = rssMap[lv.id];
    if (rssEntry && rssEntry.published && new Date(rssEntry.published).getTime() !== new Date(lv.published).getTime()) {
      console.log(`    ↻ Date fix [${lv.id}]: ${lv.published} → ${rssEntry.published}`);
      lv.published = rssEntry.published;
      changed = true;
    }
  }

  // ── 3. Holodex diff: title + duration ────────────────────────────────────
  console.log(`  [${Name}] Syncing Holodex diff...`);
  try {
    const holodexVideos = await fetchHolodexVideos(resolvedId, holodexKey);
    const localMap = Object.fromEntries(local.videos.map(v => [v.id, v]));

    for (const hv of holodexVideos) {
      const lv = localMap[hv.id];
      if (!lv) continue;

      if (hv.title && hv.title !== lv.title) {
        lv.title = hv.title;
        changed = true;
      }
      if (hv.duration && hv.duration !== lv.duration) {
        lv.duration = hv.duration;
        changed = true;
      }
    }
  } catch(e) {
    console.log(`    ⚠ Holodex video sync failed: ${e.message}`);
  }

  // ── 4. Holodex diff: avatar + banner ─────────────────────────────────────
  try {
    const ch = await fetchHolodexChannel(resolvedId, holodexKey);
    const cleanPhoto  = (ch.photo  || '').replace(/=s\d+.*$/, '');
    const cleanBanner = (ch.banner || '') + (ch.banner ? '=s0' : '');

    if (cleanPhoto && cleanPhoto !== local.channel.avatarUrl) {
      local.channel.avatarUrl = cleanPhoto;
      changed = true;
      console.log(`    ↻ Avatar updated`);
    }
    if (cleanBanner && cleanBanner !== local.channel.bannerUrl) {
      local.channel.bannerUrl = cleanBanner;
      changed = true;
      console.log(`    ↻ Banner updated`);
    }
  } catch(e) {
    console.log(`    ⚠ Holodex channel sync failed: ${e.message}`);
  }

  // ── 4b. Validate avatar + banner URLs are still live ─────────────────────
  const ytKey = process.env.YT_API_KEY;
  let avatarDead = false, bannerDead = false;
  if (local.channel.avatarUrl) {
    try {
      const s = await head(local.channel.avatarUrl);
      if (s === 404 || s === 410) { avatarDead = true; console.log(`    ⚠ Avatar URL is dead (${s})`); }
    } catch(e) { console.log(`    ⚠ Avatar HEAD check failed: ${e.message}`); }
  }
  if (local.channel.bannerUrl) {
    try {
      const s = await head(local.channel.bannerUrl);
      if (s === 404 || s === 410) { bannerDead = true; console.log(`    ⚠ Banner URL is dead (${s})`); }
    } catch(e) { console.log(`    ⚠ Banner HEAD check failed: ${e.message}`); }
  }
  if ((avatarDead || bannerDead) && ytKey) {
    try {
      const fresh = await ytApiFetchBranding(resolvedId, ytKey);
      if (avatarDead && fresh.avatarUrl && fresh.avatarUrl !== local.channel.avatarUrl) {
        local.channel.avatarUrl = fresh.avatarUrl;
        changed = true;
        console.log(`    ↻ Avatar refreshed via YouTube API`);
      }
      if (bannerDead && fresh.bannerUrl && fresh.bannerUrl !== local.channel.bannerUrl) {
        local.channel.bannerUrl = fresh.bannerUrl;
        changed = true;
        console.log(`    ↻ Banner refreshed via YouTube API`);
      }
    } catch(e) { console.log(`    ⚠ YouTube API branding refresh failed: ${e.message}`); }
  } else if ((avatarDead || bannerDead) && !ytKey) {
    console.log(`    ⚠ Set YT_API_KEY to auto-fix dead avatar/banner URLs`);
  }

  // ── 5. Save if changed ────────────────────────────────────────────────────
  if (changed) {
    local.videos.sort((a, b) => new Date(b.published) - new Date(a.published));
    local.videoCount  = local.videos.length;
    local.lastUpdated = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(local, null, 2), 'utf8');
    console.log(`  ✓ ${Name} updated (${local.videoCount} videos)`);
    return { name: Name, status: 'updated' };
  }

  console.log(`  ✓ ${Name} — no changes`);
  return { name: Name, status: 'unchanged' };
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const holodexKey = process.env.HOLODEX_API_KEY;
  const csvUrl     = process.env.CSV_URL;
  const dataDir    = process.env.DATA_DIR || './data';
  const backfill   = process.env.BACKFILL === 'true';

  if (!holodexKey || !csvUrl) {
    console.error('Missing required env vars: HOLODEX_API_KEY, CSV_URL');
    process.exit(1);
  }

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   Hololive Channel Updater               ║');
  console.log('╚══════════════════════════════════════════╝\n');

  // Fetch and parse CSV
  console.log('Fetching CSV...');
  const { status, body } = await getWithRetry(csvUrl, 3);
  if (status !== 200) { console.error(`Failed to fetch CSV: HTTP ${status}`); process.exit(1); }

  const allRows = parseCSV(body);
  const rowsRaw = process.env.ROWS || 'all';
  const selectedRows = parseRows(rowsRaw, allRows);
  const talents = selectedRows.filter(r => r.Name && r.Branch && r['Channel ID']);
  console.log(`Found ${talents.length} channel(s) to update (rows: ${rowsRaw})\n`);
  if (backfill) console.log('⟳ BACKFILL mode ON — re-enriching every existing video via YouTube API (heavier run)\n');

  // Check for new channels with no JSON → flag for bootstrap
  const missing = talents.filter(r => {
    const slug = slugify(r.Name);
    return !fs.existsSync(path.join(dataDir, r.Branch.toLowerCase(), `${slug}.json`));
  });
  if (missing.length) {
    console.log(`⚠ ${missing.length} channel(s) have no JSON — run bootstrap for:`);
    missing.forEach(r => console.log(`  Row ${r._row}: ${r.Name} (${r.Branch})`));
    console.log('');
  }

  // Update all existing channels
  const summary = { updated: [], unchanged: [], missing: [], failed: [] };

  for (const talent of talents) {
    try {
      const result = await updateChannel(talent, holodexKey, dataDir, backfill);
      summary[result.status].push(result.name);
    } catch(e) {
      console.error(`  ✗ Failed for ${talent.Name}: ${e.message}`);
      summary.failed.push(talent.Name);
    }
  }

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   Summary                                ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`  Updated:   ${summary.updated.length}`);
  console.log(`  Unchanged: ${summary.unchanged.length}`);
  console.log(`  Missing:   ${summary.missing.length}`);
  console.log(`  Failed:    ${summary.failed.length}`);
  if (summary.updated.length)  console.log(`\n  Updated:  ${summary.updated.join(', ')}`);
  if (summary.failed.length)   console.log(`  Failed:   ${summary.failed.join(', ')}`);
  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
