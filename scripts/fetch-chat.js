#!/usr/bin/env node
/**
 * fetch-chat.js
 *
 * Fourth GitHub Actions script — walks the YouTube live-chat replay of finished
 * streams and records the monetary events (superchats, paid stickers,
 * memberships, milestones, gift memberships and their recipients).
 *
 * Two companion outputs per channel:
 *
 *   data/{branch}/{slug}-chat.json          ← totals, read by the Activity grid
 *   {
 *     "channelId":   "UC...",
 *     "channelName": "Kikirara Vivi",
 *     "lastUpdated": "2026-09-11T12:00:00.000Z",
 *     "streams": {
 *       "<videoId>": { "cur": { "¥": 51791 }, "sc": 50, "sticker": 2,
 *                      "member": 5, "milestone": 2, "gift": 2, "recv": 6 },
 *       "<videoId>": 0,                            ← processed, nothing monetary
 *       "<videoId>": { "e": "noreplay", "n": 2 }   ← failed, attempt count
 *     }
 *   }
 *
 *   data/{branch}/chat/{slug}/YYYY-MM.json  ← full logs, fetched on click only
 *   { "<videoId>": [ { t, k, who, id, cur, amt, c, m }, ... ] }
 *
 * Logs are bundled by month rather than per stream: one file per stream would
 * be ~62,000 files, which makes clones and checkouts crawl. Monthly bundles are
 * ~4,500 files with a ~230 KB median, and clicking a second stream in the same
 * month is then already cached.
 *
 * Chat replay is NOT published the moment a stream ends — YouTube takes a while
 * to process it. That is why `recent` mode looks back over a window rather than
 * only at what ended since the last run: streams get retried until the replay
 * appears, then are skipped forever after.
 *
 * Env vars:
 *   MODE         'recent' (default) | 'backfill'
 *   ROWS         backfill only — sheet rows, same syntax as update.js
 *                ('78', '2-10', '2,5,74' or 'all')
 *   CSV_URL      backfill only — talent sheet, to resolve ROWS → channels
 *   WINDOW_HOURS recent only — how far back to look       (default 36)
 *   CONCURRENCY  streams walked in parallel               (default 6)
 *   BUDGET_MIN   stop cleanly after this many minutes     (default 300)
 *   MAX_ATTEMPTS give up on a stream after N failures     (default 4)
 *   DATA_DIR     path to data folder                      (default ./data)
 *
 * No API key and no quota: this is the same undocumented innertube endpoint the
 * site's worker already uses for live status. It can change without notice.
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const ENDPOINT = 'https://www.youtube.com/youtubei/v1/live_chat/get_live_chat_replay'
               + '?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const CONTEXT  = { client: { clientName: 'WEB', clientVersion: '2.20240726.00.00', hl: 'en', gl: 'US' } };
const UA       = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

// ── helpers ──────────────────────────────────────────────────────────────────

// The CSV/row helpers below mirror update.js so ROWS means the same thing in
// both workflows — row 78 is the same talent whichever script you run.

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

/** YouTube text nodes are either {simpleText} or {runs:[…]}; emotes are runs. */
function txt(node) {
  if (!node) return '';
  if (node.simpleText) return node.simpleText;
  return (node.runs || []).map(r => r.text || (r.emoji && r.emoji.shortcuts && r.emoji.shortcuts[0]) || '').join('');
}

/** "¥5,000" → {cur:'¥', amt:5000}   "NT$30.00" → {cur:'NT$', amt:30} */
function money(s) {
  const m = String(s || '').match(/^([^\d]*)\s*([\d.,]+)/);
  if (!m) return { cur: '?', amt: 0 };
  return { cur: m[1].trim() || '?', amt: parseFloat(m[2].replace(/,/g, '')) || 0 };
}

/** Pull the replay continuation token out of a watch page. */
async function replayToken(videoId) {
  const res = await fetch('https://www.youtube.com/watch?v=' + videoId, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;
  const html = await res.text();
  const m = html.match(/ytInitialData\s*=\s*(\{[\s\S]*?\});<\/script>/);
  if (!m) return null;
  let data;
  try { data = JSON.parse(m[1]); } catch (e) { return null; }
  const lcr = data
    && data.contents
    && data.contents.twoColumnWatchNextResults
    && data.contents.twoColumnWatchNextResults.conversationBar
    && data.contents.twoColumnWatchNextResults.conversationBar.liveChatRenderer;
  if (!lcr || !lcr.continuations || !lcr.continuations[0]) return null;
  const rc = lcr.continuations[0].reloadContinuationData;
  return (rc && rc.continuation) || null;
}

/**
 * Walk one stream's chat replay end to end.
 * → { log: [...], pages } or { unavailable: true }
 */
async function walkChat(videoId) {
  let cont = await replayToken(videoId);
  if (!cont) return { unavailable: true };

  const log = [];
  let pages = 0;

  while (cont) {
    const res = await fetch(ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body:    JSON.stringify({ context: CONTEXT, continuation: cont }),
    });
    if (!res.ok) break;

    let lc;
    try {
      const parsed = JSON.parse(await res.text());
      lc = parsed && parsed.continuationContents && parsed.continuationContents.liveChatContinuation;
    } catch (e) { break; }
    if (!lc) break;

    for (const action of (lc.actions || [])) {
      const replay = action.replayChatItemAction;
      if (!replay) continue;
      const t = Math.round((+replay.videoOffsetTimeMsec || 0) / 1000);

      for (const inner of (replay.actions || [])) {
        const item = inner.addChatItemAction && inner.addChatItemAction.item;
        if (!item) continue;

        // The object carries exactly one key, and that key is the event type.
        const entry = Object.entries(item)[0];
        const kind = entry[0], v = entry[1];
        const base = { t: t, who: txt(v.authorName), id: v.authorExternalChannelId };

        if (kind === 'liveChatPaidMessageRenderer') {
          const mv = money(txt(v.purchaseAmountText));
          log.push(Object.assign({}, base, { k: 'sc', cur: mv.cur, amt: mv.amt,
                                             c: v.bodyBackgroundColor, m: txt(v.message) }));

        } else if (kind === 'liveChatPaidStickerRenderer') {
          const mv = money(txt(v.purchaseAmountText));
          log.push(Object.assign({}, base, { k: 'sticker', cur: mv.cur, amt: mv.amt,
                                             c: v.backgroundColor }));

        } else if (kind === 'liveChatMembershipItemRenderer') {
          // A milestone ("Member for 6 months") carries headerPrimaryText; a
          // brand-new membership carries only the tier name in headerSubtext.
          log.push(Object.assign({}, base, { k: v.headerPrimaryText ? 'milestone' : 'member',
                                             tier: txt(v.headerSubtext),
                                             m: txt(v.headerPrimaryText) }));

        } else if (kind === 'liveChatSponsorshipsGiftPurchaseAnnouncementRenderer') {
          const h = v.header && v.header.liveChatSponsorshipsHeaderRenderer;
          log.push(Object.assign({}, base, { k: 'gift', who: txt(h && h.authorName),
                                             m: txt(h && h.primaryText) }));

        } else if (kind === 'liveChatSponsorshipsGiftRedemptionAnnouncementRenderer') {
          log.push(Object.assign({}, base, { k: 'recv', m: txt(v.message) }));
        }
        // liveChatTextMessageRenderer and friends are the other ~99.8% — dropped.
      }
    }

    const next = (lc.continuations || [])[0];
    cont = (next && next.liveChatReplayContinuationData && next.liveChatReplayContinuationData.continuation) || null;
    pages++;
  }

  return { log: log, pages: pages };
}

/** Roll a log into the compact summary the Activity grid reads. */
function summarise(log) {
  if (!log.length) return 0;
  const s = { cur: {}, sc: 0, sticker: 0, member: 0, milestone: 0, gift: 0, recv: 0 };
  for (const e of log) {
    if (e.k === 'sc' || e.k === 'sticker') {
      s.cur[e.cur] = +(((s.cur[e.cur] || 0) + e.amt).toFixed(2));
    }
    if (s[e.k] !== undefined) s[e.k]++;
  }
  for (const k of ['sticker', 'member', 'milestone', 'gift', 'recv']) if (!s[k]) delete s[k];
  if (!Object.keys(s.cur).length) delete s.cur;
  return s;
}

/** Every channel JSON, skipping the -views/-chat companions. */
function findChannelFiles(dataDir) {
  const results = [];
  if (!fs.existsSync(dataDir)) return results;
  for (const branch of fs.readdirSync(dataDir)) {
    const branchPath = path.join(dataDir, branch);
    if (!fs.statSync(branchPath).isDirectory()) continue;
    for (const file of fs.readdirSync(branchPath)) {
      if (!file.endsWith('.json')) continue;
      if (file.endsWith('-views.json') || file.endsWith('-chat.json')) continue;
      results.push(path.join(branchPath, file));
    }
  }
  return results;
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}

/** Run tasks with a fixed number of workers, stopping when the budget expires. */
async function pool(items, size, worker, shouldStop) {
  let i = 0, stopped = false;
  const run = async () => {
    while (i < items.length) {
      if (shouldStop()) { stopped = true; return; }
      await worker(items[i++]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
  return { stopped: stopped, processed: i };
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const dataDir     = process.env.DATA_DIR || './data';
  const mode        = (process.env.MODE || 'recent').toLowerCase();
  const windowHours = parseInt(process.env.WINDOW_HOURS || '36', 10);
  const concurrency = parseInt(process.env.CONCURRENCY  || '6', 10);
  const budgetMin   = parseInt(process.env.BUDGET_MIN   || '300', 10);
  const maxAttempts = parseInt(process.env.MAX_ATTEMPTS || '4', 10);
  const rowsRaw     = (process.env.ROWS || 'all').trim();
  const csvUrl      = process.env.CSV_URL;

  const deadline = Date.now() + budgetMin * 60 * 1000;
  const expired  = () => Date.now() > deadline;

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   Hololive Chat / Superchat Fetcher      ║');
  console.log('╚══════════════════════════════════════════╝\n');
  console.log('  mode=' + mode + '  concurrency=' + concurrency + '  budget=' + budgetMin + 'min'
            + (mode === 'recent' ? '  window=' + windowHours + 'h' : '  rows=' + rowsRaw) + '\n');

  let channelFiles;

  if (mode === 'backfill' && rowsRaw.toLowerCase() !== 'all') {
    // Resolve ROWS through the talent sheet, exactly as update.js does, so a
    // row number means the same talent in both workflows.
    if (!csvUrl) {
      console.error('❌  Missing CSV_URL — needed to resolve ROWS to channels');
      process.exit(1);
    }
    console.log('Fetching CSV...');
    const { status, body } = await get(csvUrl);
    if (status !== 200) { console.error('Failed to fetch CSV: HTTP ' + status); process.exit(1); }

    const selected = parseRows(rowsRaw, parseCSV(body))
      .filter(r => r.Name && r.Branch && r['Channel ID']);
    if (!selected.length) {
      console.error('❌  No talents matched ROWS="' + rowsRaw + '"');
      process.exit(1);
    }

    channelFiles = [];
    for (const r of selected) {
      const p = path.join(dataDir, r.Branch.toLowerCase(), slugify(r.Name) + '.json');
      if (fs.existsSync(p)) {
        channelFiles.push(p);
        console.log('  Row ' + r._row + ': ' + r.Name + ' (' + r.Branch + ')');
      } else {
        console.log('  ⚠ Row ' + r._row + ': ' + r.Name + ' — no JSON, run bootstrap first');
      }
    }
    if (!channelFiles.length) { console.error('❌  None of the selected rows have a JSON file'); process.exit(1); }
    console.log('');
  } else {
    channelFiles = findChannelFiles(dataDir);
  }

  console.log('📂  ' + channelFiles.length + ' channel file(s) in ' + dataDir + '\n');

  const cutoff = Date.now() - windowHours * 3600 * 1000;
  const summary = { streams: 0, withMoney: 0, unavailable: 0, remaining: 0, channels: 0 };
  let ranOut = false;

  for (const filePath of channelFiles) {
    if (expired()) { ranOut = true; break; }

    const channel = readJson(filePath, null);
    if (!channel) { console.error('  ✗ Could not parse ' + filePath); continue; }

    const slug       = path.basename(filePath, '.json');
    const branchPath = path.dirname(filePath);
    const chatPath   = path.join(branchPath, slug + '-chat.json');
    const chatFile   = readJson(chatPath, {
      channelId:   channel.channel && channel.channel.id,
      channelName: channel.channel && channel.channel.name,
      lastUpdated: null,
      streams:     {},
    });
    const done = chatFile.streams;

    // Candidates: finished streams we have not settled yet.
    const candidates = (channel.videos || []).filter(v => {
      if (v.type !== 'stream' || !v.published || !v.duration) return false;
      if (v.status === 'live' || v.status === 'upcoming') return false;
      if (mode === 'recent' && new Date(v.published).getTime() < cutoff) return false;
      const prev = done[v.id];
      if (prev === undefined) return true;                    // never tried
      if (prev && prev.e) return (prev.n || 0) < maxAttempts;  // retry failures
      return false;                                           // already settled
    });

    if (!candidates.length) continue;
    summary.channels++;
    console.log('  ' + ((channel.channel && channel.channel.name) || slug)
              + '  —  ' + candidates.length + ' stream(s) to process');

    const bundles = new Map();   // 'YYYY-MM' → { videoId: log }
    let changed = false;

    const result = await pool(candidates, concurrency, async (v) => {
      const r = await walkChat(v.id);
      changed = true;
      summary.streams++;

      if (r.unavailable) {
        const prev = done[v.id];
        const n = ((prev && prev.n) || 0) + 1;
        done[v.id] = { e: 'noreplay', n: n };
        summary.unavailable++;
        console.log('    ⚠ ' + v.id + '  replay not available (attempt ' + n + '/' + maxAttempts + ')');
        return;
      }

      const s = summarise(r.log);
      done[v.id] = s;
      if (s !== 0) {
        summary.withMoney++;
        const month = v.published.slice(0, 7);
        if (!bundles.has(month)) bundles.set(month, {});
        bundles.get(month)[v.id] = r.log;
      }
      console.log('    ✓ ' + v.id + '  ' + r.pages + ' pages'
                + (s === 0 ? '  (nothing monetary)'
                           : '  ' + JSON.stringify(s.cur || {}) + ' sc=' + (s.sc || 0)));
    }, expired);

    if (result.stopped) {
      ranOut = true;
      summary.remaining += candidates.length - result.processed;
    }

    // Merge month bundles into whatever is already on disk.
    for (const [month, entries] of bundles) {
      const dir = path.join(branchPath, 'chat', slug);
      fs.mkdirSync(dir, { recursive: true });
      const p = path.join(dir, month + '.json');
      fs.writeFileSync(p, JSON.stringify(Object.assign(readJson(p, {}), entries)), 'utf8');
    }

    if (changed) {
      chatFile.lastUpdated = new Date().toISOString();
      fs.writeFileSync(chatPath, JSON.stringify(chatFile, null, 2), 'utf8');
      console.log('    → saved ' + path.basename(chatPath));
    }
    if (ranOut) break;
  }

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   Summary                                ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('  Channels touched:   ' + summary.channels);
  console.log('  Streams processed:  ' + summary.streams);
  console.log('  With money:         ' + summary.withMoney);
  console.log('  Replay unavailable: ' + summary.unavailable);
  if (ranOut) {
    console.log('\n  ⏱  Time budget reached — ' + (summary.remaining || 'some') + ' stream(s) left.');
    console.log('     Re-run with the same settings to continue where this stopped.');
  } else {
    console.log('\n  ✓ Nothing left to process for this selection.');
  }
  console.log('');
}

main().catch(e => { console.error('❌ ', e); process.exit(1); });
