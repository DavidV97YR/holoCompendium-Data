#!/usr/bin/env node
/**
 * fetch-posts.js
 *
 * Collects YouTube community posts for every channel in the roster and writes
 * one file per branch (data/posts/jp.json, en.json, …). The Posts page fetches
 * a single branch file per tab, so switching tabs costs no extra requests.
 *
 * Two passes, because they cost wildly different amounts:
 *
 *   Pass 1 — feed crawl. The community tab via innertube. Cheap: a few hundred
 *            KB per channel. Gives id, text, likes and images, but only a
 *            relative "1 month ago" string, which is inaccurate enough to be
 *            unusable (a July post reads as "1 month ago" in September).
 *
 *   Pass 2 — date fill. The post permalink carries an exact datePublished in
 *            its ld+json. Costs ~780KB per post, so it only runs for posts that
 *            still have no date. During backfill that is all of them; after
 *            that it is the handful published that day. A failure leaves the
 *            date null and the next run retries it — the queue is the retry.
 *
 * Note: YouTube caps the community feed at ~200 posts per channel. Older posts
 * are unreachable at any page depth, so "backfill" means "everything YouTube
 * will still serve", not full history — and that ceiling erodes as a channel
 * keeps posting.
 *
 * Env:
 *   CSV_URL   — talent roster (the sheet update.js uses)   [required]
 *   DATA_DIR  — data folder (default: ./data)
 *   ROWS      — '74', '2-10', '2,5,74' or 'all'  (default: all)
 *   BACKFILL  — 'true' to crawl each feed as deep as YouTube allows
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const YT_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';   // public WEB key, baked into youtube.com
const UA     = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
               '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const COMMUNITY_PARAMS = 'Egljb21tdW5pdHnyBgQKAkoA';        // the Posts tab
const INNERTUBE_CTX = {
  client: { clientName: 'WEB', clientVersion: '2.20240101.00.00' },
};

const MAX_PAGES        = 250;   // runaway guard only; the real stop is a missing token
const STOP_AFTER_KNOWN = 5;     // consecutive known posts before a normal run stops
const CHANNEL_DELAY    = 2500;
const PAGE_DELAY       = 250;
const POST_DELAY       = 300;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── http ──────────────────────────────────────────────────────────────────

function get(url, headers) {
  return new Promise((resolve, reject) => {
    const opts = { headers: Object.assign({ 'user-agent': UA }, headers || {}) };
    const client = url.startsWith('https') ? https : http;
    client.get(url, opts, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return get(res.headers.location, headers).then(resolve).catch(reject);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

function post(url, payload) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload));
    const u = new URL(url);
    // Explicit hostname/path rather than handing https.request a URL object,
    // and an accept-language header: this is the exact shape that reached
    // innertube from an Actions runner during the feasibility probe.
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': data.length,
        'user-agent': UA,
        'accept-language': 'en-US,en;q=0.9',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

// ── roster ────────────────────────────────────────────────────────────────

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map((line, i) => {
    const cols = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    const row = { _row: i + 2 };
    headers.forEach((h, j) => { row[h] = cols[j] || ''; });
    return row;
  });
}

function parseRows(rowsRaw, allRows) {
  if (!rowsRaw || rowsRaw.toLowerCase() === 'all') return allRows;
  const rowNums = new Set();
  for (const part of rowsRaw.split(',')) {
    const range = part.trim().match(/^(\d+)-(\d+)$/);
    if (range) { for (let i = parseInt(range[1]); i <= parseInt(range[2]); i++) rowNums.add(i); }
    else rowNums.add(parseInt(part.trim()));
  }
  return allRows.filter(r => rowNums.has(r._row));
}

function slugify(name) {
  return name.toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// The CSV's 'Channel ID' column is a raw value bootstrap resolves (it can be a
// handle or custom URL), so it is not usable as a browseId. update.js has the
// same constraint and solves it the same way: take the resolved UC id from the
// talent's JSON, which bootstrap wrote.
function resolvedChannelId(talent, dataDir) {
  const fp = path.join(dataDir, talent.Branch.toLowerCase(), slugify(talent.Name) + '.json');
  if (!fs.existsSync(fp)) return null;
  try { return (JSON.parse(fs.readFileSync(fp, 'utf8')).channel || {}).id || null; }
  catch (e) { return null; }
}

// ── payload walking ───────────────────────────────────────────────────────

// Collect every value stored under `key`, anywhere in the tree. Continuation
// responses come back pretty-printed, so matching against the raw text silently
// misses posts — the shape has to be walked.
function collect(node, key, out) {
  out = out || [];
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const v of node) collect(v, key, out); return out; }
  for (const k in node) {
    if (k === key) out.push(node[k]);
    collect(node[k], key, out);
  }
  return out;
}

// Same walk, but gathering several keys at once. A browse response is a few
// hundred KB and tens of thousands of nodes, so walking it three times per page
// (posts, shared posts, continuation) tripled the allocation for no reason —
// enough to exhaust the heap partway through a large backfill slice.
function collectKeys(node, keys, out) {
  out = out || {};
  for (const k of keys) if (!out[k]) out[k] = [];
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const v of n) walk(v); return; }
    for (const k in n) {
      if (out[k]) out[k].push(n[k]);
      walk(n[k]);
    }
  })(node);
  return out;
}

// V8 stores a substring of 13+ characters as a pointer into its parent rather
// than a copy, so keeping one keeps the whole source string alive. Every field
// below is carved out of a response body — a date out of a ~780KB permalink
// page, text out of a ~300KB feed payload — and they live in the store for the
// rest of the run. Left as slices they pinned ~1.9GB and exhausted the heap
// partway through a backfill. Copying them costs nothing at these sizes.
function flat(s) {
  return (typeof s === 'string' && s.length) ? Buffer.from(s, 'utf8').toString('utf8') : s;
}

function runsText(obj) {
  return collect(obj || {}, 'runs').reduce((acc, runs) => {
    if (!Array.isArray(runs)) return acc;
    return acc + runs.map(r => (r && r.text) || '').join('');
  }, '');
}

// The feed hands back cropped square thumbnails ("=s1080-c-fcrop64=…").
// Strip every parameter to keep the bare image id: the site appends its own
// size, and "=s0" on the bare id returns the true original — 1920x1080 rather
// than a 1080x1080 crop. Storing the base also keeps these files small.
function imageBase(url) {
  if (!url) return null;
  const i = url.indexOf('=');
  return flat(i === -1 ? url : url.slice(0, i));
}

function extractImages(node) {
  const bases = [];
  for (const set of collect(node || {}, 'thumbnails')) {
    if (!Array.isArray(set) || !set.length) continue;
    const biggest = set.reduce((a, b) => ((b.width || 0) > (a.width || 0) ? b : a));
    // Author avatars ride along in the same payload at 32–88px. Post images and
    // attached video thumbnails are hundreds of pixels wide, so size separates
    // them without having to know every renderer's shape.
    if ((biggest.width || 0) < 200) continue;
    const base = imageBase(biggest.url);
    if (base && bases.indexOf(base) === -1) bases.push(base);
  }
  return bases;
}

function extractPost(p) {
  if (!p || !p.postId) return null;

  // A repost of something since deleted. YouTube still renders the reposter's
  // own comment above a "This post is no longer available" tombstone, but the
  // thing being pointed at is gone, and its permalink is a blank page with no
  // date on it — so there is nothing worth showing and no way to date it.
  if (p.originalPostDeletedMessage) return null;

  // A repost (sharedPostRenderer) keeps its text under `content` and carries no
  // voteCount, where an ordinary post uses `contentText`. Reading only the
  // latter left every repost stored with no text at all.
  const text   = flat(runsText(p.contentText || p.content));
  const likes  = flat((p.voteCount && (p.voteCount.simpleText || runsText(p.voteCount))) || '');
  // Walk the whole renderer rather than just backstageAttachment: a repost
  // nests its image or video thumbnail inside `content`. The size filter in
  // extractImages keeps author avatars out.
  const images = extractImages(p);

  // Backstop for anything else that arrives with no displayable content.
  if (!text && !images.length && !likes) return null;

  return {
    id:        flat(p.postId),
    published: null,                                   // filled by pass 2
    text:      text,
    likes:     likes,
    images:    images,
  };
}

// ── pass 1: feed crawl ────────────────────────────────────────────────────

async function crawlFeed(channelId, knownIds, backfill) {
  const found = [];
  const refresh = [];
  const seen = new Set();
  let token = null, pages = 0, consecutiveKnown = 0, truncated = false;

  while (pages < MAX_PAGES) {
    const payload = token
      ? { context: INNERTUBE_CTX, continuation: token }
      : { context: INNERTUBE_CTX, browseId: channelId, params: COMMUNITY_PARAMS };

    const res = await post('https://www.youtube.com/youtubei/v1/browse?key=' + YT_KEY, payload);
    pages++;
    if (res.status !== 200)
      throw new Error('innertube HTTP ' + res.status + ' — ' + res.body.slice(0, 300).replace(/\s+/g, ' '));

    let json = null;
    try { json = JSON.parse(res.body); }
    catch (e) { throw new Error('unparseable response on page ' + pages); }

    // One walk for everything this page needs.
    const hits = collectKeys(json, ['backstagePostRenderer', 'sharedPostRenderer', 'continuationCommand']);
    const renderers = hits.backstagePostRenderer.concat(hits.sharedPostRenderer);

    for (const r of renderers) {
      const p = extractPost(r);
      if (!p || seen.has(p.id)) continue;
      seen.add(p.id);
      if (knownIds.has(p.id)) {
        consecutiveKnown++;
        // A backfill re-reads the whole feed anyway, so hand back what a known
        // post looks like now. That makes backfill repair records written by an
        // older extractor rather than only adding new ones — the same job
        // full-recheck.yml does for videos. Normal runs skip this.
        if (backfill) refresh.push(p);
      } else {
        consecutiveKnown = 0;
        found.push(p);
      }
    }

    // Stop only on a missing continuation token. Pages arrive in lumpy batches
    // and an empty one means nothing — one channel returned eight empty pages
    // with more posts after every single one.
    const next = hits.continuationCommand.map(c => c && c.token).filter(Boolean)[0];
    token = next || null;
    json = null;              // let the page go before fetching the next one
    if (!token) break;

    // Normal runs stop once several *consecutive* known posts have gone by.
    // Never stop at the first: pinned posts sit at the top regardless of age
    // and carry no flag, so "stop at first known" halts on page 1 forever.
    if (!backfill && consecutiveKnown >= STOP_AFTER_KNOWN) break;

    await sleep(PAGE_DELAY);
  }

  if (pages >= MAX_PAGES) truncated = true;
  return { found: found, refresh: refresh, pages: pages, truncated: truncated };
}

// ── pass 2: exact publish dates ───────────────────────────────────────────

async function fetchDate(postId) {
  const res = await get('https://www.youtube.com/post/' + postId);
  if (res.status !== 200) return null;
  // ld+json carries DiscussionForumPosting.datePublished. The relative string
  // in the feed is not merely coarse — it is wrong.
  const m = res.body.match(/"datePublished"\s*:\s*"([^"]+)"/);
  return m ? flat(m[1]) : null;
}

// ── per channel ───────────────────────────────────────────────────────────

async function doChannel(talent, channelId, store, backfill) {
  const branch = talent.Branch.toLowerCase();

  const bucket = store[branch] || (store[branch] = []);
  const byId = new Map(bucket.map(p => [p.id, p]));

  const crawl = await crawlFeed(channelId, new Set(byId.keys()), backfill);
  for (const p of crawl.found) {
    p.channel = channelId;
    bucket.push(p);
    byId.set(p.id, p);
  }

  // Repair fields on posts we already hold, keeping the date we paid for.
  let repaired = 0;
  for (const p of (crawl.refresh || [])) {
    const cur = byId.get(p.id);
    if (!cur) continue;
    if (cur.text === p.text && cur.likes === p.likes &&
        (cur.images || []).join() === p.images.join()) continue;
    cur.text = p.text; cur.likes = p.likes; cur.images = p.images;
    repaired++;
  }

  // Date-fill anything still missing one, for this channel only.
  const undated = bucket.filter(p => p.channel === channelId && !p.published);
  let dated = 0, dateFails = 0;
  for (const p of undated) {
    try {
      const d = await fetchDate(p.id);
      if (d) { p.published = d; dated++; } else { dateFails++; }
    } catch (e) { dateFails++; }
    await sleep(POST_DELAY);
  }

  return {
    name: talent.Name, branch: branch, pages: crawl.pages, truncated: crawl.truncated,
    added: crawl.found.length, repaired: repaired, dated: dated, dateFails: dateFails,
    total: bucket.filter(p => p.channel === channelId).length,
  };
}

// ── store ─────────────────────────────────────────────────────────────────

const BRANCHES = ['jp', 'en', 'id', 'dev_is', 'mekpark'];

function loadStore(dir) {
  const store = {};
  for (const b of BRANCHES) {
    const fp = path.join(dir, b + '.json');
    if (!fs.existsSync(fp)) { store[b] = []; continue; }
    try { store[b] = JSON.parse(fs.readFileSync(fp, 'utf8')).posts || []; }
    catch (e) { store[b] = []; }
  }
  return store;
}

function saveStore(dir, store) {
  fs.mkdirSync(dir, { recursive: true });
  for (const b of Object.keys(store)) {
    const posts = store[b];
    if (!posts || !posts.length) continue;
    // Newest first. Undated posts sort last rather than jumping to the top.
    posts.sort((a, b2) => (b2.published || '').localeCompare(a.published || ''));
    fs.writeFileSync(path.join(dir, b + '.json'),
      JSON.stringify({ lastUpdated: new Date().toISOString(), posts: posts }, null, 1), 'utf8');
  }
}

// ── main ──────────────────────────────────────────────────────────────────

async function main() {
  const csvUrl   = process.env.CSV_URL;
  const dataDir  = process.env.DATA_DIR || './data';
  const backfill = process.env.BACKFILL === 'true';
  const rowsRaw  = process.env.ROWS || 'all';

  if (!csvUrl) { console.error('Missing required env var: CSV_URL'); process.exit(1); }

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   Community Posts                        ║');
  console.log('╚══════════════════════════════════════════╝\n');

  const csv = await get(csvUrl);
  if (csv.status !== 200) { console.error('Failed to fetch CSV: HTTP ' + csv.status); process.exit(1); }

  const selected = parseRows(rowsRaw, parseCSV(csv.body))
    .filter(r => r.Name && r.Branch);

  // The CSV picks *which* rows to process; the resolved UC id comes from each
  // talent's JSON. Talents who share a channel (FUWAMOCO, the mekPark units)
  // resolve to the same id and must only be crawled once.
  const ids = new Map();
  const seenChannels = new Set();
  const talents = [];
  const skipped = [];
  for (const t of selected) {
    const id = resolvedChannelId(t, dataDir);
    if (!id) { skipped.push(t.Name + ' (no JSON — run bootstrap)'); continue; }
    if (seenChannels.has(id)) { skipped.push(t.Name + ' (shares a channel already queued)'); continue; }
    seenChannels.add(id);
    ids.set(t, id);
    talents.push(t);
  }

  console.log(talents.length + ' channel(s) to process (rows: ' + rowsRaw + ')');
  if (skipped.length) console.log(skipped.length + ' skipped: ' + skipped.join(', '));
  console.log(backfill ? '⟳ BACKFILL — crawling each feed as deep as YouTube allows\n' : '');

  const postsDir = path.join(dataDir, 'posts');
  const store = loadStore(postsDir);
  const failed = [];
  let ok = 0;

  for (const t of talents) {
    try {
      const r = await doChannel(t, ids.get(t), store, backfill);
      ok++;
      console.log('  ' + r.name.padEnd(24) + r.branch.padEnd(9) +
        String(r.pages).padStart(3) + 'p  +' + String(r.added).padStart(3) + ' new  +' +
        String(r.dated).padStart(3) + ' dated' +
        (r.repaired ? '  ~' + r.repaired + ' repaired' : '') +
        (r.dateFails ? '  ' + r.dateFails + ' date fail(s), will retry' : '') +
        '   (' + r.total + ' held)' +
        (r.truncated ? '  ⚠ hit the ' + MAX_PAGES + '-page guard' : ''));
    } catch (e) {
      // Fail soft: one bad channel must not abort the run, same as the RSS path.
      failed.push({ name: t.Name, error: e.message });
      console.log('  ' + t.Name.padEnd(24) + t.Branch.toLowerCase().padEnd(9) + '✗ ' + e.message);
    }
    // Save after every channel so a slice that dies keeps its progress.
    saveStore(postsDir, store);
    await sleep(CHANNEL_DELAY);
  }

  console.log('');
  for (const b of BRANCHES) {
    const posts = store[b] || [];
    if (!posts.length) continue;
    const undated = posts.filter(p => !p.published).length;
    console.log('  ' + (b + '.json').padEnd(14) + String(posts.length).padStart(5) + ' posts' +
      (undated ? '   ' + undated + ' still undated' : ''));
  }
  console.log('\n  ✓ ' + ok + ' ok, ' + failed.length + ' failed\n');
}

main().catch(e => { console.error(e); process.exit(1); });
