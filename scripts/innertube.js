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
// the microformat block. Both return null: the caller must not guess.

const KEY    = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';   // public WEB key, baked into youtube.com
const CLIENT = { clientName: 'WEB', clientVersion: '2.20240101.00.00', hl: 'en' };

async function player(id) {
  const r = await fetch('https://www.youtube.com/youtubei/v1/player?key=' + KEY, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ context: { client: CLIENT }, videoId: id }),
  });
  if (!r.ok) throw new Error('innertube HTTP ' + r.status);
  return r.json();
}

// → { title, published, type, duration, status, scheduledStart?, actualStart? } or null
async function classify(id) {
  const p  = await player(id);
  const ps = p.playabilityStatus || {};
  const vd = p.videoDetails || {};
  const mf = (p.microformat && p.microformat.playerMicroformatRenderer) || null;
  if (!mf || !vd.videoId) return null;                 // private, deleted or bot-gated

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

module.exports = { classify };
