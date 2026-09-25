'use strict';

// ── Quick new-video watcher (every 30 minutes) ──────────────────────────────
// Reads each channel's uploads feed and members feed and compares them with
// what is already saved. Nothing new → nothing else happens, so a quiet run
// is two small requests per channel. Anything new is identified by innertube
// (./innertube.js) — Short, stream, video or members — and saved at once,
// with its real start time if it is live or finished.
//
// It only ever ADDS videos. Everything else (titles, durations, status
// changes, the daily corrections) stays with update.js, which also treats
// anything this adds as already known. A video innertube cannot identify
// (bot-gated, or already private) is left for update.js rather than guessed.

const fs   = require('fs');
const path = require('path');
const { classify } = require('./innertube');

const DATA_DIR = process.env.DATA_DIR || './data';
const pause = ms => new Promise(r => setTimeout(r, ms));

function decodeHtmlEntities(str) {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// Same parse as update.js's fetchRSS. A channel with no members feed answers
// 404, which is simply an empty list.
async function feed(playlistId) {
  const r = await fetch('https://www.youtube.com/feeds/videos.xml?playlist_id=' + playlistId);
  if (r.status === 404) return [];
  if (!r.ok) throw new Error('RSS HTTP ' + r.status + ' for ' + playlistId);
  const body = await r.text();
  const out = [];
  for (const m of body.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const id = m[1].match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
    const t  = m[1].match(/<title>([^<]+)<\/title>/);
    const p  = m[1].match(/<published>([^<]+)<\/published>/);
    if (id) out.push({ id: id[1].trim(), title: t ? decodeHtmlEntities(t[1].trim()) : '', published: p ? p[1].trim() : '' });
  }
  return out;
}

// Every talent file, grouped by channel. Talents who share a channel (the
// mekPark units, FUWAMOCO) each keep their own copy of its video list, so a
// new video has to reach every file in the group.
function channels() {
  const groups = new Map();
  for (const branch of fs.readdirSync(DATA_DIR)) {
    const dir = path.join(DATA_DIR, branch);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json') || /-(chat|views)\.json$/.test(name)) continue;
      const file = path.join(dir, name);
      let doc;
      try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      const id = doc && doc.channel && doc.channel.id;
      if (!id || !Array.isArray(doc.videos)) continue;
      if (!groups.has(id)) groups.set(id, { name: doc.channel.name || name, files: [] });
      groups.get(id).files.push({ file, doc });
    }
  }
  return groups;
}

async function main() {
  const started = Date.now();
  const groups = channels();
  let added = 0, skipped = 0, failed = 0;

  for (const [channelId, group] of groups) {
    const suffix = channelId.replace(/^UC/, '');
    const known  = new Set(group.files.flatMap(f => f.doc.videos.map(v => v.id)));

    let uploads, members;
    try {
      [uploads, members] = await Promise.all([feed('UU' + suffix), feed('UUMO' + suffix)]);
    } catch (e) {
      console.log(`  ⚠ ${group.name}: ${e.message}`); failed++; continue;
    }
    const memberIds = new Set(members.map(e => e.id));
    const fresh = [...uploads, ...members].filter((e, i, a) => !known.has(e.id) && a.findIndex(x => x.id === e.id) === i);
    if (!fresh.length) continue;

    const records = [];
    for (const entry of fresh) {
      let info = null;
      try { info = await classify(entry.id); } catch (e) { console.log(`  ⚠ ${entry.id}: ${e.message}`); }
      if (!info) { console.log(`  … ${group.name}: ${entry.id} not identifiable yet — left for the regular update`); skipped++; continue; }
      // The members feed is YouTube's own list of members content; it wins.
      if (memberIds.has(entry.id)) info.type = 'member';
      records.push({
        id:        entry.id,
        title:     info.title || entry.title,
        published: info.published || entry.published,
        type:      info.type,
        duration:  info.duration,
        status:    info.status,
        ...(info.scheduledStart ? { scheduledStart: info.scheduledStart } : {}),
        ...(info.actualStart    ? { actualStart:    info.actualStart }    : {}),
      });
      console.log(`  + ${group.name}: [${info.type}${info.status !== 'past' ? ', ' + info.status : ''}] ${entry.id} ${(info.title || entry.title).slice(0, 50)}`);
      await pause(250);
    }
    if (!records.length) continue;

    for (const { file, doc } of group.files) {
      const have = new Set(doc.videos.map(v => v.id));
      for (const r of records) if (!have.has(r.id)) doc.videos.push({ ...r });
      // Same save as update.js: newest first, count and timestamp refreshed.
      doc.videos.sort((a, b) => new Date(b.published) - new Date(a.published));
      doc.videoCount  = doc.videos.length;
      doc.lastUpdated = new Date().toISOString();
      fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8');
    }
    added += records.length;
  }

  console.log(`\n${groups.size} channels checked in ${((Date.now() - started) / 1000).toFixed(1)}s — `
            + `${added} new video(s) added, ${skipped} left for the regular update, ${failed} feed failure(s)`);
}

main().catch(e => { console.error(e); process.exit(1); });
