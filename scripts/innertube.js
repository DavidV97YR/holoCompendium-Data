'use strict';

// ── YouTube innertube: what one video is, straight from YouTube ─────────────
// One POST to the same endpoint youtube.com's own player uses. No API key
// quota, and it answers the questions the playlist sets cannot for a video
// that has only just gone up:
//
//   isShortsEligible        → a Short
//   members-only message    → members content
//   isLiveContent + times   → a stream (upcoming / live / past, real start)
//   liveBroadcastDetails without isLiveContent → a premiere, i.e. a video
//   none of those           → a video
//
// It cannot see private or deleted videos (they answer "private video" or
// "unavailable" with no details), and a bot-gated response comes back without
// the microformat block. Both come back as { unidentified: reason }: the
// caller must not guess.

const KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';   // public WEB key, baked into youtube.com
// Tried in order. Both return the full microformat; YouTube's bot check
// ("Sign in to confirm you're not a bot") lands on individual requests from
// datacenter addresses like GitHub's, so a second client a moment later
// usually gets through where the first did not.
const CLIENTS = [
  { clientName: 'WEB',  clientVersion: '2.20240101.00.00', hl: 'en' },
  { clientName: 'MWEB', clientVersion: '2.20240101.00.00', hl: 'en' },
];

async function player(id, client) {
  const r = await fetch('https://www.youtube.com/youtubei/v1/player?key=' + KEY, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ context: { client }, videoId: id }),
  });
  if (!r.ok) throw new Error('innertube HTTP ' + r.status);
  return r.json();
}

// → { title, published, type, duration, status, scheduledStart?, actualStart? }
//   or { unidentified: reason } when no client could see it.
async function classify(id) {
  let p = null, reason = '';
  for (const [i, client] of CLIENTS.entries()) {
    if (i) await new Promise(r => setTimeout(r, 1500));
    // An HTTP or network error on one client is a reason to try the next,
    // the same as a bot check.
    try { p = await player(id, client); } catch (e) { reason = e.message; p = null; continue; }
    if (p.microformat && p.videoDetails && p.videoDetails.videoId) break;
    reason = ((p.playabilityStatus || {}).reason || (p.playabilityStatus || {}).status || 'no details').slice(0, 60);
    p = null;
  }
  if (!p) return { unidentified: reason };           // private, deleted or bot-gated
  const ps = p.playabilityStatus || {};
  const vd = p.videoDetails || {};
  const mf = p.microformat.playerMicroformatRenderer || {};

  const lb       = mf.liveBroadcastDetails || null;
  const members  = /members-only|Join this channel/i.test(JSON.stringify(ps));
  const iso      = t => { const ms = Date.parse(t); return Number.isFinite(ms) ? new Date(ms).toISOString() : ''; };

  let type = 'video';
  if (mf.isShortsEligible)                 type = 'short';
  else if (vd.isLiveContent)               type = 'stream';
  if (members)                             type = 'member';

  // A broadcast's state and times. For one that has not started, the
  // "start" YouTube gives is the scheduled one.
  let status = 'past', scheduledStart = '', actualStart = '';
  if (lb) {
    if (lb.isLiveNow)            { status = 'live';     actualStart = iso(lb.startTimestamp); }
    else if (lb.endTimestamp)    { status = 'past';     actualStart = iso(lb.startTimestamp); }
    else                         { status = 'upcoming'; scheduledStart = iso(lb.startTimestamp); }
  } else if (vd.isUpcoming) {
    status = 'upcoming';
  }

  return {
    title:     vd.title || (mf.title && mf.title.simpleText) || '',
    // publishDate is when YouTube posted it — for a finished stream, the VOD,
    // which is what every existing record's `published` already means.
    published: iso(mf.publishDate || mf.uploadDate),
    type,
    duration:  Number(vd.lengthSeconds || mf.lengthSeconds || 0),
    status,
    ...(scheduledStart ? { scheduledStart } : {}),
    ...(actualStart    ? { actualStart }    : {}),
  };
}

// ── Music: YouTube's ♪ on a video's duration badge ─────────────────────────
// youtube.com marks a music video (a cover, an original, a 3D live song) with
// a note before its length. That mark is not the video's category — PekoVivi's
// "Onegai Darling" 3D live is filed under Gaming — and nothing a single video
// answers carries it. The channel's Videos tab does: each card's badge names
// the MUSIC icon. So the whole tab is walked, page by page, as a reader would
// scroll it. Members-only videos are on it too; streams are not (they are on
// the Live tab, which is not walked).
//
// → { ids: [videoId…] (the music ones), seen: n, seenIds: Set (every video
//   on the tab), complete: true|false }
//   complete is false when a page failed part way: the caller keeps what it
//   had for the videos it did not reach rather than dropping their marks.
const VIDEOS_TAB    = 'EgZ2aWRlb3PyBgQKAjoA';
const BROWSE_CLIENT = { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'en' };

async function browse(body) {
  const r = await fetch('https://www.youtube.com/youtubei/v1/browse?key=' + KEY, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ context: { client: BROWSE_CLIENT }, ...body }),
  });
  if (!r.ok) throw new Error('innertube HTTP ' + r.status);
  return r.json();
}

// One page: every badge's video, and the grid's next-page token. The next
// page is the LAST entry of the grid's list; the page carries other
// continuations too (menus, chips) that lead somewhere else.
function scanPage(page, seen, music) {
  let token = null;
  (function walk(x) {
    if (!x || typeof x !== 'object') return;
    const b = x.thumbnailBadgeViewModel;
    if (b && b.animationActivationTargetId) {
      seen.add(b.animationActivationTargetId);
      const icons = ((b.icon || {}).sources || []).map(s => (s.clientResource || {}).imageName);
      if (icons.includes('MUSIC')) music.add(b.animationActivationTargetId);
    }
    const list = (x.richGridRenderer && x.richGridRenderer.contents)
              || (x.appendContinuationItemsAction && x.appendContinuationItemsAction.continuationItems);
    if (list) {
      const c = list[list.length - 1] && list[list.length - 1].continuationItemRenderer;
      token = (c && c.continuationEndpoint && c.continuationEndpoint.continuationCommand
               && c.continuationEndpoint.continuationCommand.token) || null;
    }
    for (const k in x) walk(x[k]);
  })(page);
  return token;
}

async function musicVideos(channelId) {
  const seen = new Set(), music = new Set();
  let complete = false;
  try {
    let token = scanPage(await browse({ browseId: channelId, params: VIDEOS_TAB }), seen, music);
    // A channel has a few hundred videos at most (Suisei: 7 pages of 30); the
    // cap only stops a token that never ends.
    for (let pages = 1; token && pages < 100; pages++) {
      await new Promise(r => setTimeout(r, 200));
      token = scanPage(await browse({ continuation: token }), seen, music);
    }
    // A first page with no cards at all is a bot check or a changed layout,
    // not a channel without videos: a failure, not "no music".
    complete = !token && seen.size > 0;
  } catch (e) { /* complete stays false */ }
  return { ids: [...music].sort(), seen: seen.size, seenIds: seen, complete };
}

// ── Newest uploads, from the channel's own tabs ────────────────────────────
// What watch-new.js reads when the uploads feed fails: the first page of the
// Videos, Shorts and Live tabs (30–48 cards each, more than the feed's 15),
// newest first. A members-only card carries YouTube's BADGE_MEMBERS_ONLY.
//
// → { videos: [{ id, members }], shorts: [...], streams: [...] }
//   A tab the channel does not have is an empty list: YouTube answers with
//   its Home tab instead, which is told apart by the tab marked selected.
//   Throws when no tab came back at all (a bot check or a changed layout),
//   so the caller can say the channel was not checked.
const CHANNEL_TABS = {
  videos:  { params: VIDEOS_TAB,                 title: 'Videos' },
  shorts:  { params: 'EgZzaG9ydHPyBgUKA5oBAA==', title: 'Shorts' },
  streams: { params: 'EgdzdHJlYW1z8gYECgJ6AA==', title: 'Live' },
};

async function channelTabs(channelId) {
  const out = {};
  let answered = 0;
  for (const [name, tab] of Object.entries(CHANNEL_TABS)) {
    const page = await browse({ browseId: channelId, params: tab.params });
    let selected = null;
    const cards = [];
    (function walk(x) {
      if (!x || typeof x !== 'object') return;
      if (x.tabRenderer && x.tabRenderer.selected) selected = x.tabRenderer.title;
      if (x.richItemRenderer) {
        const s  = JSON.stringify(x.richItemRenderer);
        const id = (s.match(/"(?:videoId|contentId)":"([\w-]{11})"/) || [])[1];
        if (id) cards.push({ id, members: s.includes('BADGE_MEMBERS_ONLY') });
        return;
      }
      for (const k in x) walk(x[k]);
    })(page);
    if (selected) answered++;
    out[name] = selected === tab.title ? cards : [];
    await new Promise(r => setTimeout(r, 200));
  }
  if (!answered) throw new Error('no channel tabs returned');
  return out;
}

module.exports = { classify, musicVideos, channelTabs };
