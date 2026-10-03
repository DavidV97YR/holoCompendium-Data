#!/usr/bin/env node
/**
 * prune-chat-orphans.js
 *
 * One-off tidy-up after the private-stream cleanup of 2026-09-25 ("remove
 * private past streams (one-time)"). That commit took the streams out of each
 * talent's {slug}.json, but the chat data fetch-chat.js had already gathered
 * for them stayed behind:
 *
 *   {branch}/{slug}-chat.json              → its summary in "streams"
 *   {branch}/chat/{slug}/YYYY-MM.json      → its full log
 *
 * The site's Stats page adds every summary in {slug}-chat.json to a talent's
 * totals, so those removed streams were still counted there (and only there:
 * build-ranks.js reads streams from {slug}.json, so Rank had dropped them).
 *
 * This removes chat data only for the 118 streams that cleanup removed
 * (CLEANED below, taken from that commit's diff), and only where the stream is
 * still absent from its talent's {slug}.json. Nothing else can be touched:
 * streams that went private AFTER the cleanup are not on the list, and are
 * kept. A talent whose {slug}.json cannot be read, or lists no videos, is
 * skipped rather than emptied.
 *
 * Env:
 *   DRY_RUN   'true' (default) lists what would be removed and writes nothing
 *   DATA_DIRS comma-separated folders (default ./data,./vspo)
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const DRY  = (process.env.DRY_RUN || 'true') !== 'false';
const DIRS = (process.env.DATA_DIRS || './data,./vspo').split(',').map(s => s.trim()).filter(Boolean);

// Every stream id the 2026-09-25 commit "remove private past streams
// (one-time)" deleted from a talent file.
const CLEANED = new Set([
  '-CW89avOj3c', '0L2BzfoL_ro', '0LM1ocKQs2E', '0kvVjjA0j7M', '12m77Znl-SI', '1WszwMy5fwc',
  '1eS20AlGok4', '32rd2-5vEYE', '3InqyVRGFTo', '3NE9KUMKZH0', '40TUDvIQz38', '4_zXm3DZNL4',
  '4fIlr008mJQ', '4hdm0zAuI4E', '4xcsUyX3UI4', '5YXrXHTVydo', '5xVDwgTZZig', '6jAhWAGd-jw',
  '71RbIturcnM', '8An5QQsDp7M', '8IAMuUg79A4', '9qjb2Z9Yzz8', '9vaxfw1qFcY', 'A8wNRxkZGdc',
  'ATStQxlLRlE', 'BOmtYSp9Vlw', 'Bkd_sRV_CU8', 'C1hXB1NIGmM', 'DQemCAxKpAo', 'ENlNsWX4PEI',
  'FTB3hkuCNs0', 'G007tD6tLt8', 'G6dJJ-Z93Z0', 'GxLMvV3v5rU', 'HBT2gRTtV58', 'HFCvn1Fw4Js',
  'HNlJljkwFAQ', 'I6DbAjVZSrk', 'I6L9hnGCpwk', 'IySQc2JLBog', 'JCTOUzRhsP8', 'JMp4o5WcJKE',
  'JdxwtmSExA0', 'JuwkxK4_GSc', 'KW77gP3XvA4', 'Khz_C3BFbWU', 'KjsgusiAMRQ', 'L3kboCesUTo',
  'Mog8FQYz4-g', 'N-RBlIBPbic', 'N6kbwtuBs6Y', 'Nfhfs4tNRlE', 'OP7IsdeTqFk', 'OmWdFdtCTWM',
  'PtCNqj8C-2M', 'QLRHj2xNh-k', 'T-9wvhhyc6o', 'T4rUBNWmKfA', 'TB1o1nprSGI', 'V35upi1zT7Q',
  'VBiX-53-lbI', 'VRmkl5pNBD0', 'VeVOGjX3L2E', 'W-r4wqpIuN4', 'Wu-qOz24zmg', 'X1gxkuNzMf4',
  'X3BMUAr_hqo', 'XXQE5V2v9dg', 'XtcbIwNE4JU', 'Z6mk1u4slvk', '_8zbCVELEm4', '_oD9pYwd2Os',
  'atpf9cL8fd4', 'boIfgHnBjAo', 'cOQJ0UFMm2Q', 'eFkylhywqKU', 'eGuJ5KpUp8Q', 'emiAWXejfVw',
  'fHtgHknHC3Y', 'gij9NVZBqqU', 'hYL1mAwI0eA', 'i0C3wsGt-ps', 'iR7U7czME9o', 'iRc8ZsYDK5c',
  'ie3moZQzDH8', 'ioKr7duvHZQ', 'jGlv9HGtOTw', 'jlCgqoHsYlo', 'jrjTiWbtny0', 'jweWWNZxM7c',
  'k8seCPPfO1g', 'kgd0CD40S6g', 'kxCeHe-OmaE', 'la20TwUUbig', 'lmOt3GS0UnI', 'm1rHV8GMckY',
  'nB4YFh10DgY', 'nw4coXG-zCg', 'opAtcx6GIKc', 'p-DnSNIxoZE', 'pulP400cTpE', 'qUcdLZOxVIk',
  'r2UcH814i7w', 'rBB95cNpEp4', 'sA36jXnDXYo', 't8chcZWHYHs', 'tpYDP9JBTVg', 'u2Xr_BnUkT0',
  'v6ZbXSJ501M', 'vIGbbcGJSzM', 'vevJMpC6Pvc', 'vsF_EMoNjnk', 'wg2BTTC0Mic', 'wi-QysXMreI',
  'xgGqifCMhv4', 'z3Ofu6a0GNY', 'zSXkEPdLIIo', 'zn2VL5wWC1c',
]);

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

let summaries = 0, logs = 0, files = 0;

for (const dir of DIRS) {
  if (!fs.existsSync(dir)) continue;
  for (const branch of fs.readdirSync(dir).sort()) {
    const bp = path.join(dir, branch);
    if (branch === 'posts' || !fs.statSync(bp).isDirectory()) continue;

    for (const f of fs.readdirSync(bp).sort()) {
      if (!f.endsWith('.json') || f.endsWith('-views.json') || f.endsWith('-chat.json')) continue;
      const slug     = f.slice(0, -5);
      const chatPath = path.join(bp, slug + '-chat.json');
      if (!fs.existsSync(chatPath)) continue;

      const data = readJson(path.join(bp, f));
      if (!data || !Array.isArray(data.videos) || !data.videos.length) {
        console.log('  skip ' + branch + '/' + slug + ': its video list could not be read');
        continue;
      }
      const listed = new Set(data.videos.map(v => v && v.id).filter(Boolean));

      // The summaries.
      const chat   = readJson(chatPath);
      const gone   = Object.keys((chat && chat.streams) || {}).filter(id => !listed.has(id) && CLEANED.has(id));
      if (!gone.length) continue;
      console.log('  ' + branch + '/' + slug + ': ' + gone.join(', '));
      summaries += gone.length;
      if (!DRY) {
        for (const id of gone) delete chat.streams[id];
        // Written as fetch-chat.js writes it.
        fs.writeFileSync(chatPath, JSON.stringify(chat, null, 2), 'utf8');
        files++;
      }

      // The full logs, bundled by month.
      const logDir = path.join(bp, 'chat', slug);
      if (!fs.existsSync(logDir)) continue;
      for (const m of fs.readdirSync(logDir).filter(n => n.endsWith('.json')).sort()) {
        const lp     = path.join(logDir, m);
        const bundle = readJson(lp);
        if (!bundle) continue;
        const hit = gone.filter(id => Object.prototype.hasOwnProperty.call(bundle, id));
        if (!hit.length) continue;
        console.log('    log ' + m + ': ' + hit.join(', '));
        logs += hit.length;
        if (!DRY) {
          for (const id of hit) delete bundle[id];
          fs.writeFileSync(lp, JSON.stringify(bundle), 'utf8');
          files++;
        }
      }
    }
  }
}

console.log((DRY ? 'Dry run: would remove ' : 'Removed ') + summaries + ' stream summar' + (summaries === 1 ? 'y' : 'ies')
  + ' and ' + logs + ' log' + (logs === 1 ? '' : 's') + (DRY ? '' : ' (' + files + ' files written)') + '.');
