#!/usr/bin/env node

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const readline = require('readline');

// ── helpers ───────────────────────────────────────────────────────────────────

function get(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    let data = '';
    client.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return get(res.headers.location).then(resolve).catch(reject);
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

function extractHandle(raw) {
  const m = raw.match(/@([\w-]+)/);
  if (m) return m[1];
  if (raw.startsWith('UC')) return raw.trim();
  return null;
}

function slugify(name) {
  return name.toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function ytGet(endpoint, params, apiKey) {
  const qs = new URLSearchParams({ ...params, key: apiKey }).toString();
  const url = `https://www.googleapis.com/youtube/v3/${endpoint}?${qs}`;
  const { status, body } = await get(url);
  if (status !== 200) throw new Error(`YouTube API ${status}: ${body.slice(0, 200)}`);
  return JSON.parse(body);
}

async function resolveChannelId(raw, apiKey) {
  if (raw.startsWith('UC')) return raw.trim();
  const handle = extractHandle(raw);
  if (!handle) throw new Error(`Cannot parse channel: ${raw}`);
  const data = await ytGet('channels', { part: 'id', forHandle: handle }, apiKey);
  if (!data.items?.length) throw new Error(`No channel found for @${handle}`);
  return data.items[0].id;
}

async function fetchPlaylist(playlistId, apiKey) {
  const items = [];
  let pageToken = '';
  do {
    const params = { part: 'snippet', playlistId, maxResults: 50 };
    if (pageToken) params.pageToken = pageToken;
    let data;
    try {
      data = await ytGet('playlistItems', params, apiKey);
    } catch(e) {
      if (e.message.includes('404')) { console.log(`     ⚠ Playlist ${playlistId} not found (skipped)`); return []; }
      throw e;
    }
    items.push(...(data.items || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return items;
}

async function fetchVideoDetails(videoIds, apiKey) {
  const details = {};
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const data = await ytGet('videos', { part: 'contentDetails,snippet', id: batch.join(',') }, apiKey);
    for (const item of (data.items || [])) {
      details[item.id] = { duration: item.contentDetails?.duration || '' };
    }
  }
  return details;
}

function parseDuration(iso) {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
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

// ── process one channel ───────────────────────────────────────────────────────

async function processChannel(talent, apiKey, outputDir) {
  const { Name, Branch, 'Channel ID': channelRaw } = talent;
  console.log(`\n  → Resolving channel ID for ${Name}...`);

  const channelId = await resolveChannelId(channelRaw, apiKey);
  const suffix = channelId.replace(/^UC/, '');

  console.log(`     Channel ID: ${channelId}`);
  console.log(`     Fetching channel branding (avatar, banner)...`);

  const brandingData = await ytGet('channels', { part: 'snippet,brandingSettings', id: channelId }, apiKey);
  const brandingItem = brandingData.items?.[0];
  const rawAvatarUrl = brandingItem?.snippet?.thumbnails?.high?.url
    || brandingItem?.snippet?.thumbnails?.medium?.url
    || brandingItem?.snippet?.thumbnails?.default?.url || '';
  const avatarUrl = rawAvatarUrl.replace(/=s\d+.*$/, '');
  const bannerRaw = brandingItem?.brandingSettings?.image?.bannerExternalUrl || '';
  const bannerUrl = bannerRaw ? `${bannerRaw}=s0` : '';

  console.log(`     Fetching playlists (UULF, UUSH, UUMO, UU)...`);

  const [videosItems, shortsItems, membersItems, allItems] = await Promise.all([
    fetchPlaylist(`UULF${suffix}`, apiKey),
    fetchPlaylist(`UUSH${suffix}`, apiKey),
    fetchPlaylist(`UUMO${suffix}`, apiKey),
    fetchPlaylist(`UU${suffix}`,   apiKey),
  ]);

  const videoIds  = new Set(videosItems.map(i => i.snippet.resourceId.videoId));
  const shortIds  = new Set(shortsItems.map(i => i.snippet.resourceId.videoId));
  const memberIds = new Set(membersItems.map(i => i.snippet.resourceId.videoId));

  const allMapped = allItems.map(item => {
    const id = item.snippet.resourceId.videoId;
    let type = 'stream';
    if (videoIds.has(id))  type = 'video';
    if (shortIds.has(id))  type = 'short';
    if (memberIds.has(id)) type = 'member';
    return { id, type, snippet: item.snippet };
  });

  // Members-only not in UU (private to non-members)
  const allIds = new Set(allMapped.map(v => v.id));
  for (const item of membersItems) {
    const id = item.snippet.resourceId.videoId;
    if (!allIds.has(id)) allMapped.push({ id, type: 'member', snippet: item.snippet });
  }

  console.log(`     Videos: ${videoIds.size}  Shorts: ${shortIds.size}  Members: ${memberIds.size}  Streams (derived): ${allMapped.filter(v=>v.type==='stream').length}  Total: ${allMapped.length}`);
  console.log(`     Fetching video details in batches...`);

  const uniqueIds = [...new Set(allMapped.map(v => v.id))];
  const details = await fetchVideoDetails(uniqueIds, apiKey);

  const videos = allMapped.map(({ id, type, snippet }) => ({
    id,
    title:     snippet.title || '',
    published: snippet.publishedAt || '',
    thumbnail: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
    type,
    duration:  parseDuration(details[id]?.duration),
  }));

  videos.sort((a, b) => new Date(b.published) - new Date(a.published));

  const slug = slugify(Name);
  const branchDir = path.join(outputDir, Branch.toLowerCase());
  fs.mkdirSync(branchDir, { recursive: true });

  const out = {
    channel: { id: channelId, name: Name, branch: Branch, slug, avatarUrl, bannerUrl },
    lastUpdated: new Date().toISOString(),
    videoCount: videos.length,
    videos,
  };

  const filePath = path.join(branchDir, `${slug}.json`);
  fs.writeFileSync(filePath, JSON.stringify(out, null, 2), 'utf8');

  const detailCalls  = Math.ceil(uniqueIds.length / 50);
  const playlistCalls = [videosItems, shortsItems, membersItems, allItems]
    .reduce((acc, arr) => acc + (Math.ceil(arr.length / 50) || 1), 0);
  const quotaUsed = 1 + 1 + playlistCalls + detailCalls; // resolve + branding + playlists + details

  console.log(`     ✓ Saved to ${filePath}`);
  console.log(`     📊 Quota used (approx): ${quotaUsed} units`);

  return { name: Name, videos: videos.length, quota: quotaUsed };
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  // CI mode: read from environment variables (set by GitHub Actions)
  const isCi = !!process.env.YT_API_KEY;

  let apiKey, csvUrl, rowsRaw, outDir;

  if (isCi) {
    apiKey  = process.env.YT_API_KEY;
    csvUrl  = process.env.CSV_URL;
    rowsRaw = process.env.ROWS || 'all';
    outDir  = process.env.OUT_DIR || './data';
    console.log(`\n[CI mode] rows="${rowsRaw}" outDir="${outDir}"`);
  } else {
    // Interactive mode
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise(res => rl.question(q, res));

    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║   Hololive Channel Bootstrap Script      ║');
    console.log('╚══════════════════════════════════════════╝\n');

    apiKey  = (await ask('YouTube API key: ')).trim();
    csvUrl  = (await ask('Google Sheets CSV URL: ')).trim();
    rowsRaw = (await ask('Rows to process (e.g. 2,5,74 or 2-10 or "all"): ')).trim();
    outDir  = (await ask('Output directory [./data]: ')).trim() || './data';

    console.log('\nFetching CSV...');
    const { status, body } = await get(csvUrl);
    if (status !== 200) { console.error(`Failed to fetch CSV: HTTP ${status}`); rl.close(); process.exit(1); }

    const allRows = parseCSV(body);
    console.log(`Loaded ${allRows.length} talent rows from CSV`);

    const selectedRows = parseRows(rowsRaw, allRows);
    const valid = selectedRows.filter(r => r.Name && r.Branch && r['Channel ID']);
    const skipped = selectedRows.length - valid.length;
    if (skipped) console.log(`⚠  Skipped ${skipped} row(s) with missing fields`);
    if (!valid.length) { console.log('No valid rows to process.'); rl.close(); return; }

    console.log(`\nWill process ${valid.length} channel(s):`);
    valid.forEach(r => console.log(`  Row ${r._row}: ${r.Name} (${r.Branch})`));

    const confirm = (await ask('\nProceed? (y/n): ')).trim().toLowerCase();
    rl.close();
    if (confirm !== 'y') { console.log('Aborted.'); return; }

    // Run after rl closed
    await runAll(valid, apiKey, outDir);
    return;
  }

  // CI path
  console.log('Fetching CSV...');
  const { status, body } = await get(csvUrl);
  if (status !== 200) { console.error(`Failed to fetch CSV: HTTP ${status}`); process.exit(1); }

  const allRows = parseCSV(body);
  console.log(`Loaded ${allRows.length} talent rows from CSV`);

  const selectedRows = parseRows(rowsRaw, allRows);
  const valid = selectedRows.filter(r => r.Name && r.Branch && r['Channel ID']);
  if (!valid.length) { console.log('No valid rows to process.'); return; }

  console.log(`Processing ${valid.length} channel(s):`);
  valid.forEach(r => console.log(`  Row ${r._row}: ${r.Name} (${r.Branch})`));

  await runAll(valid, apiKey, outDir);
}

async function runAll(valid, apiKey, outDir) {
  const summary = [];
  let totalQuota = 0;

  for (const talent of valid) {
    try {
      const result = await processChannel(talent, apiKey, outDir);
      summary.push(result);
      totalQuota += result.quota;
    } catch (e) {
      console.error(`  ✗ Failed for ${talent.Name}: ${e.message}`);
      summary.push({ name: talent.Name, videos: 0, quota: 0, error: e.message });
    }
  }

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   Summary                                ║');
  console.log('╚══════════════════════════════════════════╝');
  for (const r of summary) {
    if (r.error) console.log(`  ✗ ${r.name}: ${r.error}`);
    else console.log(`  ✓ ${r.name}: ${r.videos} videos, ~${r.quota} quota units`);
  }
  console.log(`\n  Total quota used (approx): ${totalQuota} / 10,000 daily units`);
  console.log(`  Remaining: ~${10000 - totalQuota} units\n`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
