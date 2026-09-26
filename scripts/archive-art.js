'use strict';

// ── Channel art archive ─────────────────────────────────────────────────────
// Keeps every avatar and banner each channel has had, at full resolution, in
// the R2 bucket hololive-youtube-image-archive:
//
//   <branch>/<talent>/<date>/avatar.webp
//   <branch>/<talent>/<date>/banner.webp
//
// One folder per channel: talents who share one (FUWAMOCO, the mekPark units)
// are filed under the shared name, the same slug the site uses for them.
//
// How a change is noticed: YouTube never reuses an image link — a new avatar or
// banner gets a new one — and update.js refreshes each channel's links every
// run. So a link that differs from the last one archived means "look again".
// The original is then downloaded (`=s0`) and fingerprinted (SHA-256): the same
// picture under a differently formatted link (Holodex and YouTube spell them
// differently) is not a new version, only the link on record is updated. A
// talent going back to an image they had before gets a new dated entry that
// points at the file already stored, rather than a second copy.
//
// Images are converted to LOSSLESS WebP, so every pixel matches the original.
// YouTube does not say when an image changed, so a version's date is the day
// this run found it (it runs after every update, so within about two hours).
//
// This script only writes: new files under OUT_DIR, ready to upload, and the
// index at data/art-archive.json. The workflow uploads, then commits the index,
// so the index never names a file that failed to upload.

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const sharp  = require('sharp');

const DATA_DIR = process.env.DATA_DIR || './data';
const OUT_DIR  = process.env.OUT_DIR  || './art-out';
const INDEX    = path.join(DATA_DIR, 'art-archive.json');

// Shared channels, filed under the name the site gives them (CHANNEL_ALIASES
// in the site's js/shared.js).
const SHARED = {
  'fuwawa-abyssgard': 'fuwamoco',  'mococo-abyssgard': 'fuwamoco',
  'yoinagi-neon':     'unit-b',    'reimei-mira':      'unit-b',   'kiyosumi-lyra':  'unit-b',
  'sumishio-sayana':  'achrora',   'rumigaki-rirara':  'achrora',  'yuikawa-hinami': 'achrora',
};

// The link without its size/format suffix: the part that identifies the image.
const base = url => String(url || '').replace(/=[^/]*$/, '');
const isYtArt = url => /^https:\/\/yt3\.(ggpht|googleusercontent)\.com\//.test(url || '');

// One entry per channel, from its talent files.
function channels() {
  const out = new Map();
  for (const branch of fs.readdirSync(DATA_DIR)) {
    const dir = path.join(DATA_DIR, branch);
    if (!fs.statSync(dir).isDirectory() || branch === 'posts') continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json') || /-(chat|views)\.json$/.test(name)) continue;
      let doc;
      try { doc = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
      const ch = doc && doc.channel;
      if (!ch || !ch.id) continue;
      const slug = name.slice(0, -5);
      const folder = branch + '/' + (SHARED[slug] || slug);
      if (!out.has(folder)) out.set(folder, { channelId: ch.id, avatar: ch.avatarUrl, banner: ch.bannerUrl });
    }
  }
  return out;
}

async function download(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url);
      if (r.status === 404 || r.status === 410) return null;           // gone from YouTube
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise(res => setTimeout(res, attempt * 2000));
    }
  }
}

async function main() {
  const started = Date.now();
  const index = fs.existsSync(INDEX) ? JSON.parse(fs.readFileSync(INDEX, 'utf8')) : { channels: {} };
  index.channels = index.channels || {};
  const today = new Date().toISOString().slice(0, 10);
  let stored = 0, relinked = 0, reused = 0, gone = 0, failed = 0, bytes = 0;

  for (const [folder, ch] of channels()) {
    const rec = index.channels[folder] || (index.channels[folder] = { channelId: ch.channelId, avatar: [], banner: [] });
    rec.channelId = ch.channelId;
    for (const kind of ['avatar', 'banner']) {
      const url = ch[kind];
      if (!url || !isYtArt(url)) continue;
      const hist = rec[kind] || (rec[kind] = []);
      const last = hist[hist.length - 1];
      const src  = base(url);
      if (last && last.src === src) continue;                           // unchanged link: nothing to fetch

      let buf;
      try { buf = await download(src + '=s0'); }
      catch (e) { console.log(`  ⚠ ${folder} ${kind}: ${e.message}`); failed++; continue; }
      if (!buf) { console.log(`  … ${folder} ${kind}: no longer on YouTube`); gone++; continue; }

      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      if (last && last.sha256 === sha) {                                // same picture, new link
        last.src = src; relinked++; continue;
      }
      const earlier = hist.find(h => h.sha256 === sha);
      // Changed twice in one day: the second gets the time as well (with
      // seconds, should a manual run land in the same minute).
      const taken = new Set(hist.map(h => h.date));
      const now   = new Date().toISOString();
      const date  = !taken.has(today) ? today
                  : !taken.has(today + '_' + now.slice(11, 16).replace(':', '')) ? today + '_' + now.slice(11, 16).replace(':', '')
                  : today + '_' + now.slice(11, 19).replace(/:/g, '');
      if (earlier) {                                                    // back to an older image
        hist.push({ date, key: earlier.key, src, sha256: sha, width: earlier.width, height: earlier.height, bytes: earlier.bytes });
        console.log(`  ↺ ${folder} ${kind}: back to the ${earlier.date} image`);
        reused++; continue;
      }

      let webp, meta;
      try {
        const img = sharp(buf, { limitInputPixels: false });
        meta = await img.metadata();
        webp = await img.webp({ lossless: true, effort: 6 }).toBuffer();
      } catch (e) { console.log(`  ⚠ ${folder} ${kind}: could not convert (${e.message})`); failed++; continue; }

      const key = `${folder}/${date}/${kind}.webp`;
      fs.mkdirSync(path.join(OUT_DIR, path.dirname(key)), { recursive: true });
      fs.writeFileSync(path.join(OUT_DIR, key), webp);
      hist.push({ date, key, src, sha256: sha, width: meta.width, height: meta.height, bytes: webp.length });
      console.log(`  + ${key}  ${meta.width}×${meta.height}  ${(buf.length / 1024).toFixed(0)}KB → ${(webp.length / 1024).toFixed(0)}KB`);
      stored++; bytes += webp.length;
    }
  }

  if (stored || relinked || reused) {
    index.lastUpdated = new Date().toISOString();
    fs.writeFileSync(INDEX, JSON.stringify(index, null, 2) + '\n', 'utf8');
  }
  console.log(`\n${Object.keys(index.channels).length} channels in ${((Date.now() - started) / 1000).toFixed(1)}s — `
            + `${stored} new image(s) (${(bytes / 1048576).toFixed(1)}MB), ${reused} back to an older image, `
            + `${relinked} same image under a new link, ${gone} no longer on YouTube, ${failed} failed`);
}

main().catch(e => { console.error(e); process.exit(1); });
