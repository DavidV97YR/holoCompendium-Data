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
    let data = '';
    const opts = { headers };
    if (url.startsWith('https')) opts.agent = agent;
    client.get(url, opts, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return get(res.headers.location, headers).then(resolve).catch(reject);
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
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

function decodeHtmlEntities(str) {
  return str.replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'");
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

function holodexGet(apiKey, endpoint) {
  const url = `https://holodex.net/api/v2${endpoint}`;
  return get(url, { 'X-APIKEY': apiKey }).then(({ status, body }) => {
    if (status !== 200) throw new Error(`Holodex API ${status}: ${body.slice(0, 200)}`);
    return JSON.parse(body);
  });
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

async function updateChannel(talent, holodexKey, dataDir) {
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
  for (const prefix of Object.keys(feeds)) {
    try {
      feeds[prefix] = await fetchRSS(`${prefix}${suffix}`);
    } catch(e) {
      console.log(`    ⚠ RSS ${prefix} failed: ${e.message}`);
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
        local.videos.unshift({
          id:        entry.id,
          title:     detail.title || entry.title,
          published: detail.published_at || entry.published,
          thumbnail: `https://i.ytimg.com/vi/${entry.id}/maxresdefault.jpg`,
          type:      entry.type,
          duration:  detail.duration || 0,
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

  // ── 2. Holodex diff: title + duration ─────────────────────────────────────
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

  // ── 3. Holodex diff: avatar + banner ──────────────────────────────────────
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

  // ── 4. Save if changed ────────────────────────────────────────────────────
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
  const talents = allRows.filter(r => r.Name && r.Branch && r['Channel ID']);
  console.log(`Found ${talents.length} channels to update\n`);

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
      const result = await updateChannel(talent, holodexKey, dataDir);
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

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
