#!/usr/bin/env node
/**
 * test-posts.js  —  THROWAWAY PROBE, delete once it has answered its question.
 *
 * Asks one thing: can GitHub Actions runners reach YouTube's innertube browse
 * endpoint for community posts, or do they get bot-challenged?
 *
 * Actions runs on Azure ranges, which YouTube guards harder on innertube than
 * on the RSS feeds update.js already uses 4,000x/day without trouble. That
 * difference is the whole risk, and it's empirical — so measure it.
 *
 * Writes nothing, commits nothing, touches no data. Prints a summary.
 *
 * Env:
 *   DATA_DIR  path to data folder (default ./data)
 *   DELAY_MS  throttle between channels (default 2500)
 *   LIMIT     only probe the first N channels (default: all)
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = process.env.DATA_DIR || './data';
const DELAY_MS = parseInt(process.env.DELAY_MS || '2500', 10);
const LIMIT    = parseInt(process.env.LIMIT    || '0', 10);

// Public WEB client key baked into youtube.com — same one worker.js uses.
const KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
// base64 of the "community" tab selector
const COMMUNITY_PARAMS = 'Egljb21tdW5pdHnyBgQKAkoA';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': data.length,
        // A plain node UA is an obvious tell; mirror a normal browser.
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
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

function findChannels(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const branch of fs.readdirSync(dir)) {
    const bp = path.join(dir, branch);
    if (!fs.statSync(bp).isDirectory()) continue;
    for (const f of fs.readdirSync(bp)) {
      if (!f.endsWith('.json') || f.endsWith('-views.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(bp, f), 'utf8'));
        const id = j.channel && j.channel.id;
        if (id) out.push({ id, name: (j.channel.name || f), file: f });
      } catch (_) {}
    }
  }
  // One entry per YouTube channel — shared channels (FUWAMOCO, mekPark units)
  // appear under several talent files and must not be probed twice.
  const seen = new Set();
  return out.filter(c => !seen.has(c.id) && seen.add(c.id));
}

// Tell apart "blocked" from "this channel simply has no posts" — an empty
// community tab is a valid answer, not a failure, and conflating the two
// would make a working setup look broken.
function classify(status, body) {
  if (status !== 200) return { kind: 'blocked', why: 'HTTP ' + status };
  if (/consent\.youtube\.com|Sign in to confirm|captcha|unusual traffic/i.test(body))
    return { kind: 'blocked', why: 'bot challenge' };
  let j;
  try { j = JSON.parse(body); } catch (e) { return { kind: 'blocked', why: 'unparseable' }; }
  if (!j.contents) return { kind: 'blocked', why: 'no contents' };
  const s = JSON.stringify(j);
  const posts = new Set([...s.matchAll(/"postId":"([\w-]+)"/g)].map(m => m[1]));
  if (posts.size) return { kind: 'ok_posts', count: posts.size };
  return { kind: 'ok_empty', count: 0 };
}

async function main() {
  let channels = findChannels(DATA_DIR);
  if (LIMIT > 0) channels = channels.slice(0, LIMIT);
  if (!channels.length) { console.error('No channels found in ' + DATA_DIR); process.exit(1); }

  console.log(`\nProbing ${channels.length} channel(s), ${DELAY_MS}ms apart\n`);

  const tally = { ok_posts: 0, ok_empty: 0, blocked: 0, error: 0 };
  const failures = [];
  let totalPosts = 0, bytes = 0;
  const t0 = Date.now();

  for (let i = 0; i < channels.length; i++) {
    const c = channels[i];
    const n = String(i + 1).padStart(3);
    try {
      const res = await post(`https://www.youtube.com/youtubei/v1/browse?key=${KEY}`, {
        context: { client: { clientName: 'WEB', clientVersion: '2.20240101.00.00' } },
        browseId: c.id,
        params: COMMUNITY_PARAMS,
      });
      bytes += res.body.length;
      const r = classify(res.status, res.body);
      tally[r.kind]++;
      if (r.kind === 'ok_posts') {
        totalPosts += r.count;
        console.log(`${n}  ✓ ${String(r.count).padStart(2)} posts  ${c.name}`);
      } else if (r.kind === 'ok_empty') {
        console.log(`${n}  · no posts   ${c.name}`);
      } else {
        failures.push(`${c.name} (${c.id}): ${r.why}`);
        console.log(`${n}  ✗ ${r.why.padEnd(11)} ${c.name}`);
      }
    } catch (e) {
      tally.error++;
      failures.push(`${c.name} (${c.id}): ${e.message}`);
      console.log(`${n}  ✗ ${String(e.message).slice(0, 11).padEnd(11)} ${c.name}`);
    }
    if (i < channels.length - 1) await sleep(DELAY_MS);
  }

  const secs = Math.round((Date.now() - t0) / 1000);
  const reachable = tally.ok_posts + tally.ok_empty;
  console.log('\n──────── RESULT ────────');
  console.log(`reached OK      : ${reachable}/${channels.length}`);
  console.log(`  with posts    : ${tally.ok_posts}  (${totalPosts} posts seen)`);
  console.log(`  empty tab     : ${tally.ok_empty}`);
  console.log(`blocked         : ${tally.blocked}`);
  console.log(`network errors  : ${tally.error}`);
  console.log(`downloaded      : ${(bytes / 1048576).toFixed(1)} MB in ${secs}s`);
  if (failures.length) {
    console.log('\nfailures:');
    failures.slice(0, 20).forEach(f => console.log('  ' + f));
    if (failures.length > 20) console.log(`  …and ${failures.length - 20} more`);
  }
  console.log('\nVERDICT: ' + (
    reachable === channels.length ? 'innertube works from Actions — safe to build on.'
    : reachable === 0             ? 'fully blocked from Actions — use the Worker route instead.'
    :                               'partially blocked — unreliable from Actions, prefer the Worker route.'
  ) + '\n');
}

main();
