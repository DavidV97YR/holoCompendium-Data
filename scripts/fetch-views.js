#!/usr/bin/env node
/**
 * fetch-views.js
 *
 * Third GitHub Actions script — fetches YouTube view counts for every video
 * across all bootstrapped channel JSONs and writes a companion *-views.json
 * file next to each channel file.
 *
 * Output shape (data/{branch}/{slug}-views.json):
 * {
 *   "channelId":   "UC...",
 *   "channelName": "Isaki Riona",
 *   "lastUpdated": "2026-06-03T12:00:00.000Z",
 *   "views": {
 *     "<videoId>": <viewCount>,
 *     ...
 *   }
 * }
 *
 * Required env vars (set as GitHub Actions secrets):
 *   YT_API_KEY  — YouTube Data API v3 key
 *   DATA_DIR    — path to data folder (default: ./data)
 *
 * Quota cost: 1 unit per 50 videos  (~2,000–4,000 units for all 77 channels)
 * Well within the 10,000/day free quota when run once daily.
 */

const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');

// ── helpers ──────────────────────────────────────────────────────────────────

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

async function ytGet(endpoint, params, apiKey) {
  const qs  = new URLSearchParams({ ...params, key: apiKey }).toString();
  const url = `https://www.googleapis.com/youtube/v3/${endpoint}?${qs}`;
  const { status, body } = await get(url);
  if (status !== 200)
    throw new Error(`YouTube API ${status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

/** Fetch view counts for up to any number of video IDs, batched 50 at a time. */
async function fetchViewCounts(videoIds, apiKey) {
  const views = {};
  let quotaUsed = 0;

  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const data  = await ytGet(
      'videos',
      { part: 'statistics', id: batch.join(','), maxResults: 50 },
      apiKey,
    );
    quotaUsed++;

    for (const item of (data.items || [])) {
      const count = item.statistics?.viewCount;
      // Store as number; undefined / missing → null (avoids silent 0 confusion)
      views[item.id] = count !== undefined ? parseInt(count, 10) : null;
    }

    // Small throttle — keeps us well away from any per-second limits
    if (i + 50 < videoIds.length)
      await new Promise(r => setTimeout(r, 150));
  }

  return { views, quotaUsed };
}

/** Recursively find all *-views.json companion targets from channel JSONs. */
function findChannelFiles(dataDir) {
  const results = [];
  if (!fs.existsSync(dataDir)) return results;

  for (const branch of fs.readdirSync(dataDir)) {
    const branchPath = path.join(dataDir, branch);
    if (!fs.statSync(branchPath).isDirectory()) continue;

    for (const file of fs.readdirSync(branchPath)) {
      // Only process channel files, skip any existing -views.json files
      if (!file.endsWith('.json') || file.endsWith('-views.json')) continue;
      results.push(path.join(branchPath, file));
    }
  }
  return results;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey  = process.env.YT_API_KEY;
  const dataDir = process.env.DATA_DIR || './data';

  if (!apiKey) {
    console.error('❌  Missing required env var: YT_API_KEY');
    process.exit(1);
  }

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   Hololive View Count Fetcher            ║');
  console.log('╚══════════════════════════════════════════╝\n');

  const channelFiles = findChannelFiles(dataDir);

  if (!channelFiles.length) {
    console.error(`❌  No channel JSON files found in ${dataDir} — run bootstrap first.`);
    process.exit(1);
  }

  console.log(`📂  Found ${channelFiles.length} channel file(s) in ${dataDir}\n`);

  const summary = {
    updated:   [],
    unchanged: [],
    failed:    [],
    totalVideos: 0,
    totalQuota:  0,
  };

  for (const filePath of channelFiles) {
    let channel;
    try {
      channel = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      console.error(`  ✗ Could not parse ${filePath}: ${e.message}`);
      summary.failed.push(filePath);
      continue;
    }

    const { id: channelId, name: channelName } = channel.channel || {};
    const videos = channel.videos || [];

    if (!channelId || !videos.length) {
      console.log(`  ⚠  Skipping ${path.basename(filePath)} — no channel ID or videos`);
      continue;
    }

    // Exclude member-only videos — YouTube API returns 0 or omits them for non-members
    const publicVideos = videos.filter(v => v.type !== 'member');
    const videoIds     = publicVideos.map(v => v.id);

    console.log(`  → ${channelName}  (${videoIds.length} public videos)`);

    const viewsFilePath = filePath.replace(/\.json$/, '-views.json');

    // Load existing views so we can detect changes
    let existingViews = {};
    if (fs.existsSync(viewsFilePath)) {
      try {
        existingViews = JSON.parse(fs.readFileSync(viewsFilePath, 'utf8')).views || {};
      } catch (_) { /* start fresh if file is corrupt */ }
    }

    let views, quotaUsed;
    try {
      ({ views, quotaUsed } = await fetchViewCounts(videoIds, apiKey));
    } catch (e) {
      console.error(`    ✗ API error: ${e.message}`);
      summary.failed.push(channelName);
      continue;
    }

    summary.totalVideos += videoIds.length;
    summary.totalQuota  += quotaUsed;

    // Check whether anything actually changed
    const changed = Object.keys(views).some(id => views[id] !== existingViews[id]);

    if (!changed && Object.keys(existingViews).length > 0) {
      console.log(`    ✓ No changes (${quotaUsed} quota unit${quotaUsed !== 1 ? 's' : ''})`);
      summary.unchanged.push(channelName);
      continue;
    }

    const out = {
      channelId,
      channelName,
      lastUpdated: new Date().toISOString(),
      views,
    };

    fs.writeFileSync(viewsFilePath, JSON.stringify(out), 'utf8');
    console.log(`    ✓ Saved ${path.basename(viewsFilePath)}  (~${quotaUsed} quota unit${quotaUsed !== 1 ? 's' : ''})`);
    summary.updated.push(channelName);
  }

  // ── summary ────────────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   Summary                                ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`  Updated:     ${summary.updated.length}`);
  console.log(`  Unchanged:   ${summary.unchanged.length}`);
  console.log(`  Failed:      ${summary.failed.length}`);
  console.log(`  Total videos processed: ${summary.totalVideos.toLocaleString()}`);
  console.log(`  Total quota used: ~${summary.totalQuota.toLocaleString()} / 10,000 units`);
  console.log(`  Remaining:   ~${(10000 - summary.totalQuota).toLocaleString()} units\n`);

  if (summary.failed.length) {
    console.log(`  Failed channels: ${summary.failed.join(', ')}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
