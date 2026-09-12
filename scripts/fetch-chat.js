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

// Mirrors update.js's get(), plus a User-Agent. A header-less request gets an
// intermittent 401 from Google even though the sheet is public — measured as
// 200,200,401 over three tries — which is what broke the first CI run. Sending
// an Accept header makes it worse (intermittent 400), so UA is the only one.
const agent = new https.Agent({ rejectUnauthorized: false });

function get(url, headers) {
  const hdrs = Object.assign({ 'User-Agent': UA }, headers || {});
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const opts = { headers: hdrs };
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

/** Google occasionally rejects a cold request; a couple of retries settles it. */
async function getWithRetry(url, attempts) {
  let last = null;
  for (let i = 1; i <= (attempts || 3); i++) {
    try {
      const r = await get(url);
      if (r.status === 200) return r;
      last = r;
      console.log('  ⚠ CSV fetch attempt ' + i + ': HTTP ' + r.status);
    } catch (e) {
      last = { status: 0, body: e.message };
      console.log('  ⚠ CSV fetch attempt ' + i + ': ' + e.message);
    }
    if (i < (attempts || 3)) await new Promise(r => setTimeout(r, i * 3000));
  }
  return last;
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

/**
 * fetch() REJECTS on a network error rather than returning a bad status, and it
 * will wait forever on a hung socket. Unguarded, one blip anywhere in a 5-hour
 * backfill takes the whole run down with it — and since progress is only
 * written when a channel's pool finishes, everything processed so far is lost.
 * So: never throw, always time out.
 */
async function safeFetch(url, opts, ms) {
  try {
    const res = await fetch(url, Object.assign({}, opts || {},
      { signal: AbortSignal.timeout(ms || 45000) }));
    return { ok: res.ok, status: res.status, res: res };
  } catch (e) {
    return { ok: false, status: 0, err: (e && e.name === 'TimeoutError') ? 'timeout' : 'neterr' };
  }
}

/** → { token } | { err } */
async function replayToken(videoId) {
  const r = await safeFetch('https://www.youtube.com/watch?v=' + videoId,
                            { headers: { 'User-Agent': UA } }, 45000);
  if (!r.ok) return { err: r.err || ('http' + r.status) };
  let html;
  try { html = await r.res.text(); } catch (e) { return { err: 'neterr' }; }

  // Separate the genuinely permanent cases from "couldn't see it this time".
  // Members-only needs a login and an unplayable video is gone — no number of
  // retries fixes either, and letting them burn attempts wastes whole walks.
  if (/"status":"LOGIN_REQUIRED"/.test(html)) return { err: 'private' };
  if (/"status":"(UNPLAYABLE|ERROR)"/.test(html)) return { err: 'gone' };

  const m = html.match(/ytInitialData\s*=\s*(\{[\s\S]*?\});<\/script>/);
  if (!m) return { err: 'noreplay' };
  let data;
  try { data = JSON.parse(m[1]); } catch (e) { return { err: 'noreplay' }; }
  const lcr = data
    && data.contents
    && data.contents.twoColumnWatchNextResults
    && data.contents.twoColumnWatchNextResults.conversationBar
    && data.contents.twoColumnWatchNextResults.conversationBar.liveChatRenderer;
  if (!lcr || !lcr.continuations || !lcr.continuations[0]) return { err: 'noreplay' };
  const rc = lcr.continuations[0].reloadContinuationData;
  return (rc && rc.continuation) ? { token: rc.continuation } : { err: 'noreplay' };
}

/**
 * Walk one stream's chat replay end to end.
 * → { log: [...], pages } or { unavailable: true }
 */
async function walkChat(videoId) {
  const tok = await replayToken(videoId);
  if (tok.err) {
    if (tok.err === 'private' || tok.err === 'gone') return { permanent: tok.err };
    return { aborted: tok.err, pages: 0 };
  }
  let cont = tok.token;

  const log = [];
  let pages = 0;
  // A walk that stops early (429, 5xx, malformed page) must NOT be recorded as
  // "processed, nothing monetary" — that would settle the stream forever on the
  // strength of a network blip. Only a walk that runs out of continuations has
  // genuinely seen the whole chat.
  let complete = false;

  while (cont) {
    const r = await safeFetch(ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body:    JSON.stringify({ context: CONTEXT, continuation: cont }),
    }, 45000);
    if (!r.ok) return { aborted: r.err || ('http' + r.status), pages: pages };

    let lc;
    try {
      const parsed = JSON.parse(await r.res.text());
      lc = parsed && parsed.continuationContents && parsed.continuationContents.liveChatContinuation;
    } catch (e) { return { aborted: 'parse', pages: pages }; }
    if (!lc) return { aborted: 'nocontent', pages: pages };

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
    if (!cont) complete = true;   // ran out of continuations = saw the whole chat
  }

  if (!complete) return { aborted: 'nocontinuation', pages: pages };
  return { log: log, pages: pages };
}

/**
 * Walk a stream, retrying immediately on transient failures only.
 *
 * A dropped connection or a timeout clears in seconds, so retrying inside the
 * run costs nothing and keeps it from burning one of the four across-run
 * attempts on network noise. 'noreplay' is different — YouTube simply hasn't
 * published the replay yet, and no amount of immediate retrying helps, so that
 * one is left to wait for the next run.
 */
const TRANSIENT = ['neterr', 'timeout', 'noreplay'];

async function walkChatRetrying(videoId, tries) {
  const n = tries || 3;
  let last = null;
  for (let i = 1; i <= n; i++) {
    const r = await walkChat(videoId);
    if (!r.aborted) return r;                       // success, or permanent
    last = r;
    // 'noreplay' is in here because it isn't only "not published yet" — under
    // load YouTube serves a watch page with the chat renderer stripped out,
    // which looks identical and clears on an immediate retry.
    if (TRANSIENT.indexOf(r.aborted) < 0) return r;
    if (i < n) {
      console.log('      ↻ ' + videoId + ' ' + r.aborted + ', retrying (' + i + '/' + (n - 1) + ')');
      await new Promise(res => setTimeout(res, i * 2500));
    }
  }
  return last;
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
  for (const k of ['sc', 'sticker', 'member', 'milestone', 'gift', 'recv']) if (!s[k]) delete s[k];
  if (!Object.keys(s.cur).length) delete s.cur;
  // Only non-monetary chatter was found (shouldn't happen — we don't log it).
  if (!Object.keys(s).length) return 0;
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
  const talentsArg  = (process.env.TALENTS || "").trim();

  const deadline = Date.now() + budgetMin * 60 * 1000;
  const expired  = () => Date.now() > deadline;

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   Hololive Chat / Superchat Fetcher      ║');
  console.log('╚══════════════════════════════════════════╝\n');
  console.log('  mode=' + mode + '  concurrency=' + concurrency + '  budget=' + budgetMin + 'min'
            + (mode === 'recent' ? '  window=' + windowHours + 'h' : '  rows=' + rowsRaw) + '\n');

  let channelFiles;

  if (mode === 'backfill' && talentsArg) {
    // Escape hatch: name slugs directly and skip the sheet entirely. Useful if
    // Google is refusing the CSV from a runner IP.
    const want = new Set(talentsArg.split(',').map(s => s.trim()).filter(Boolean));
    channelFiles = findChannelFiles(dataDir).filter(f => want.has(path.basename(f, '.json')));
    if (!channelFiles.length) {
      console.error('❌  No channel files matched TALENTS="' + talentsArg + '"');
      process.exit(1);
    }
    channelFiles.forEach(f => console.log('  ' + path.basename(f, '.json')));
    console.log('');

  } else if (mode === 'backfill' && rowsRaw.toLowerCase() !== 'all') {
    // Resolve ROWS through the talent sheet, exactly as update.js does, so a
    // row number means the same talent in both workflows.
    if (!csvUrl) {
      console.error('❌  Missing CSV_URL — needed to resolve ROWS to channels');
      console.error('    (or set TALENTS=<slug> to skip the sheet entirely)');
      process.exit(1);
    }
    console.log('Fetching CSV...');
    const { status, body } = await getWithRetry(csvUrl, 3);
    if (status !== 200) {
      console.error('❌  Failed to fetch CSV: HTTP ' + status);
      console.error('    response: ' + String(body).slice(0, 200).replace(/\s+/g, ' '));
      console.error('    Set TALENTS=<slug> to bypass the sheet, e.g. TALENTS=isaki-riona');
      process.exit(1);
    }

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
  const summary = { streams: 0, withMoney: 0, unavailable: 0, permanent: 0, remaining: 0, channels: 0 };
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
      const prev = done[v.id];
      // Stragglers are swept at ANY age, including by the hourly run — a
      // stream whose replay wasn't ready, or that hit a network blip, heals
      // itself without needing the whole backfill re-run. They're rare (single
      // digits per talent), so this costs the hourly job almost nothing.
      // An error entry with no `n` is permanent (members-only / unplayable).
      if (prev && prev.e) return prev.n !== undefined && prev.n < maxAttempts;
      if (mode === 'recent' && new Date(v.published).getTime() < cutoff) return false;
      return prev === undefined;                              // never tried
    });

    if (!candidates.length) continue;
    summary.channels++;
    console.log('  ' + ((channel.channel && channel.channel.name) || slug)
              + '  —  ' + candidates.length + ' stream(s) to process');

    const bundles = new Map();   // 'YYYY-MM' → { videoId: log }
    let changed = false;

    // Flush to disk as we go. A channel's pool can run for hours and be cut off
    // by the time budget, so waiting until it finishes to write means a crash
    // or a kill throws away everything done so far.
    const flush = () => {
      for (const [month, entries] of bundles) {
        const dir = path.join(branchPath, 'chat', slug);
        fs.mkdirSync(dir, { recursive: true });
        const p = path.join(dir, month + '.json');
        fs.writeFileSync(p, JSON.stringify(Object.assign(readJson(p, {}), entries)), 'utf8');
      }
      bundles.clear();
      chatFile.lastUpdated = new Date().toISOString();
      fs.writeFileSync(chatPath, JSON.stringify(chatFile, null, 2), 'utf8');
    };
    let sinceFlush = 0;

    const result = await pool(candidates, concurrency, async (v) => {
      const r = await walkChatRetrying(v.id, 3);
      changed = true;
      summary.streams++;

      if (r.permanent) {
        done[v.id] = { e: r.permanent };       // no n → never retried
        summary.permanent++;
        console.log('    ⊘ ' + v.id + '  '
                  + (r.permanent === 'private' ? 'members-only' : 'unplayable') + ' — permanent');
        return;
      }

      if (r.unavailable || r.aborted) {
        const prev = done[v.id];
        const n = ((prev && prev.n) || 0) + 1;
        const why = r.aborted || 'noreplay';
        done[v.id] = { e: why, n: n };
        summary.unavailable++;
        console.log('    ⚠ ' + v.id + '  ' + (r.aborted ? 'walk aborted (' + why + ') after ' + r.pages + ' pages'
                                                        : 'replay not available')
                  + ' (attempt ' + n + '/' + maxAttempts + ')');
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
      // Spell out what was found — a bare "{} sc=0" reads like nothing happened
      // when it can mean memberships or gifts but no superchats.
      let what = '(nothing monetary)';
      if (s !== 0) {
        const bits = [];
        if (s.cur) bits.push(JSON.stringify(s.cur));
        if (s.sc) bits.push('sc=' + s.sc);
        for (const k of ['sticker', 'member', 'milestone', 'gift', 'recv'])
          if (s[k]) bits.push(k + '=' + s[k]);
        what = bits.join(' ');
      }
      console.log('    ✓ ' + v.id + '  ' + r.pages + ' pages  ' + what);
      if (++sinceFlush >= 20) { flush(); sinceFlush = 0; }
    }, expired);

    if (result.stopped) {
      ranOut = true;
      summary.remaining += candidates.length - result.processed;
    }

    if (changed) {
      flush();
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
  console.log('  Replay unavailable: ' + summary.unavailable + '   (will retry)');
  console.log('  Permanent:          ' + summary.permanent + '   (members-only / unplayable)');
  if (ranOut) {
    console.log('\n  ⏱  Time budget reached — ' + (summary.remaining || 'some') + ' stream(s) left.');
    console.log('     Re-run with the same settings to continue where this stopped.');
  } else {
    console.log('\n  ✓ Nothing left to process for this selection.');
  }
  console.log('');
}

main().catch(e => { console.error('❌ ', e); process.exit(1); });
