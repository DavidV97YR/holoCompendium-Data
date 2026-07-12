#!/usr/bin/env node

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// ── helpers ───────────────────────────────────────────────────────────────────

// In CI (GitHub Actions) SSL is fine; locally disable verification for dev proxies
const agent = new https.Agent({ rejectUnauthorized: false });

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const opts = { headers };
    if (url.startsWith('https')) opts.agent = agent;
    client.get(url, opts, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return get(res.headers.location, headers).then(resolve).catch(reject);
      const chunks = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

function head(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const opts = { method: 'HEAD' };
    if (url.startsWith('https')) opts.agent = agent;
    const parsed = new URL(url);
    opts.hostname = parsed.hostname;
    opts.path = parsed.pathname + parsed.search;
    client.request(opts, res => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject).end();
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

// Batch up to 50 IDs per call (1 quota unit each)
// → { id: { title, published, duration, status, scheduledStart } }
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
        scheduledStart: live?.scheduledStartTime || '',
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

async function fetchHolodexVideos(channelId, apiKey) {
  // Fetch all pages of videos for this channel
  const videos = [];
  let offset = 0;
  const limit = 50;
  while (true) {
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
  const localIds = new Set(local.videos.map(v => v.id));
  let changed = false;
  // Use channel ID from JSON — already resolved to UC... by bootstrap
  const resolvedId = local.channel.id;
  const suffix = resolvedId.replace(/^UC/, '');

  // ── 1. RSS: find new videos ────────────────────────────────────────────────
  console.log(`  [${Name}] Fetching RSS feeds...`);
  const feeds = { UULF: [], UUSH: [], UUMO: [], UU: [] };
  const rssDelay = ms => new Promise(r => setTimeout(r, ms));
  for (const prefix of Object.keys(feeds)) {
    try {
      feeds[prefix] = await fetchRSS(`${prefix}${suffix}`);
      await rssDelay(500); // 500ms between each RSS feed fetch
    } catch(e) {
      console.log(`    ⚠ RSS ${prefix} failed: ${e.message}`);
      await rssDelay(500);
    }
  }

  const videoIds  = new Set(feeds.UULF.map(e => e.id));
  const shortIds  = new Set(feeds.UUSH.map(e => e.id));
  const memberIds = new Set(feeds.UUMO.map(e => e.id));

  // Type each UU entry, derive streams via set subtraction
  const typedUU = feeds.UU.map(entry => {
    let type = 'stream';
    if (videoIds.has(entry.id))  type = 'video';
    if (shortIds.has(entry.id))  type = 'short';
    if (memberIds.has(entry.id)) type = 'member';
    return { ...entry, type };
  });

  // Collect all RSS entries with types
  const allRssEntries = [
    ...feeds.UULF.map(e => ({ ...e, type: 'video'  })),
    ...feeds.UUSH.map(e => ({ ...e, type: 'short'  })),
    ...feeds.UUMO.map(e => ({ ...e, type: 'member' })),
    ...typedUU.filter(e => e.type === 'stream'),
  ];

  // Deduplicate and find new
  const seen = new Set();
  const newEntries = [];
  for (const e of allRssEntries) {
    if (!seen.has(e.id) && !localIds.has(e.id)) {
      seen.add(e.id);
      newEntries.push(e);
    }
  }

  if (newEntries.length) {
    console.log(`    ★ ${newEntries.length} new video(s) — enriching via Holodex...`);
    for (const entry of newEntries) {
      try {
        const detail = await fetchHolodexVideoDetail(entry.id, holodexKey);
        const sched  = detail.start_scheduled || detail.available_at || '';
        local.videos.unshift({
          id:        entry.id,
          title:     detail.title || entry.title,
          published: detail.published_at || entry.published,
          thumbnail: `https://i.ytimg.com/vi/${entry.id}/maxresdefault.jpg`,
          type:      entry.type,
          duration:  detail.duration || 0,
          status:    detail.status || 'past',
          ...(sched && (detail.status === 'upcoming' || detail.status === 'live') ? { scheduledStart: sched } : {}),
        });
        console.log(`    + [${entry.type}] ${entry.id} ${(detail.title || entry.title).slice(0, 50)}`);
      } catch(e) {
        // Holodex doesn't have it yet — add from RSS with duration 0, cron will fill later
        local.videos.unshift({
          id:        entry.id,
          title:     entry.title,
          published: entry.published,
          thumbnail: `https://i.ytimg.com/vi/${entry.id}/maxresdefault.jpg`,
          type:      entry.type,
          duration:  0,
        });
        console.log(`    + [${entry.type}] ${entry.id} (Holodex miss — added from RSS)`);
      }
      localIds.add(entry.id);
      changed = true;
    }
  }

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
      console.log(`  [${Name}] Backfill: re-enriching ${allIds.length} video(s) via YouTube API...`);
      try {
        const details = await fetchYouTubeVideoDetails(allIds, ytKey);
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
          if (d.scheduledStart && d.scheduledStart !== lv.scheduledStart) { lv.scheduledStart = d.scheduledStart; changed = true; fixed++; }
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
        if (sched && sched !== lv.scheduledStart) { lv.scheduledStart = sched; changed = true; }
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
  const { status, body } = await get(csvUrl);
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
