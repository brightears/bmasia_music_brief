require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const dns = require('dns');
const Anthropic = require('@anthropic-ai/sdk');

dns.setDefaultResultOrder('ipv4first');

// ---------------------------------------------------------------------------
// SYB Playlist Catalog & AI Client
// ---------------------------------------------------------------------------
const PLAYLIST_CATALOG = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'syb-playlists.json'), 'utf8')
).playlists;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const AI_MODEL = process.env.AI_MODEL || 'claude-sonnet-4-6';
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const RECIPIENT_EMAIL = process.env.RECIPIENT_EMAIL || 'production@bmasiamusic.com';

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_APP_PASSWORD,
  },
  family: 4,
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 15000,
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '500kb' }));
app.use(express.urlencoded({ extended: true, limit: '500kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { error: 'Too many submissions. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const recommendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many recommendation requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ---------------------------------------------------------------------------
// Vibe-to-genre mapping
// ---------------------------------------------------------------------------
const VIBE_GENRES = {
  relaxed:       { genres: ['Acoustic', 'Soft Pop', 'Bossa Nova', 'Lo-fi', 'Easy Listening'], bpm: '70-100' },
  energetic:     { genres: ['Pop', 'Dance-Pop', 'House', 'Funk', 'Indie Pop'], bpm: '110-130' },
  sophisticated: { genres: ['Jazz', 'Neo-Soul', 'Classical Crossover', 'Deep House', 'Bossa Nova'], bpm: '80-115' },
  warm:          { genres: ['Acoustic', 'Folk', 'Soft Jazz', 'Indie Folk', 'Singer-Songwriter'], bpm: '75-100' },
  trendy:        { genres: ['Indie Electronic', 'Nu-Disco', 'Alt-Pop', 'Downtempo', 'Afrobeats'], bpm: '95-125' },
  upbeat:        { genres: ['Pop', 'Funk', 'Disco', 'Tropical House', 'Latin Pop'], bpm: '110-130' },
  zen:           { genres: ['Ambient', 'New Age', 'Meditation', 'Nature Sounds', 'Minimalist'], bpm: '60-85' },
  romantic:      { genres: ['Jazz Ballads', 'Neo-Soul', 'Soft R&B', 'Classical Piano', 'Bossa Nova'], bpm: '70-100' },
  luxurious:     { genres: ['Deep House', 'Jazz Lounge', 'Neo-Soul', 'Orchestral', 'Downtempo'], bpm: '85-115' },
  tropical:      { genres: ['Tropical House', 'Reggae', 'Bossa Nova', 'Island Pop', 'Afro-House'], bpm: '90-120' },
  creative:      { genres: ['Indie', 'Art Pop', 'Electronic', 'World Fusion', 'Experimental Pop'], bpm: '85-120' },
  professional:  { genres: ['Soft Jazz', 'Classical Light', 'Ambient', 'Easy Listening', 'Acoustic'], bpm: '70-100' },
};

const VENUE_BOOSTERS = {
  'hotel-lobby':    ['Jazz', 'Bossa Nova', 'Ambient', 'Classical Light'],
  'restaurant':     ['Jazz', 'Bossa Nova', 'Acoustic', 'Neo-Soul'],
  'bar-lounge':     ['Deep House', 'Nu-Disco', 'Jazz Lounge', 'Downtempo'],
  'spa-wellness':   ['Ambient', 'New Age', 'Nature Sounds', 'Minimalist'],
  'fashion-retail': ['Indie Electronic', 'Alt-Pop', 'Deep House', 'Nu-Disco'],
  'cafe':           ['Acoustic', 'Indie Folk', 'Lo-fi', 'Soft Pop'],
  'gym-fitness':    ['EDM', 'Hip-Hop', 'Pop', 'Dance'],
  'pool-beach':     ['Tropical House', 'Afro-House', 'Reggae', 'Island Pop'],
  'qsr':            ['Pop', 'Upbeat Acoustic', 'Indie Pop', 'Funk'],
  'coworking':      ['Lo-fi', 'Ambient', 'Soft Electronic', 'Acoustic'],
};

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

// ---------------------------------------------------------------------------
// Dynamic Daypart Generation
// ---------------------------------------------------------------------------
const DEFAULT_DAYPARTS = [
  { key: 'morning', label: 'Morning', timeRange: 'opening-lunch', icon: 'sunrise' },
  { key: 'afternoon', label: 'Afternoon', timeRange: 'lunch-dinner', icon: 'sun' },
  { key: 'evening', label: 'Evening', timeRange: 'dinner-close', icon: 'moon' },
];

function parseTime(str) {
  str = str.trim().toLowerCase();
  const ampm = str.match(/(am|pm)$/);
  str = str.replace(/(am|pm)$/, '').trim().replace('.', ':');
  let hours, minutes = 0;
  if (str.includes(':')) {
    [hours, minutes] = str.split(':').map(Number);
  } else {
    hours = parseInt(str, 10);
    if (hours >= 100) { minutes = hours % 100; hours = Math.floor(hours / 100); }
  }
  if (ampm) {
    if (ampm[1] === 'pm' && hours !== 12) hours += 12;
    if (ampm[1] === 'am' && hours === 12) hours = 0;
  }
  return hours * 60 + (minutes || 0);
}

function timeLabel(mins) {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function iconForTime(mins) {
  const h = Math.floor(((mins % 1440) + 1440) % 1440 / 60);
  if (h >= 5 && h < 11) return 'sunrise';
  if (h >= 11 && h < 16) return 'sun';
  if (h >= 16 && h < 19) return 'sunset';
  if (h >= 19) return 'moon';
  return 'stars'; // 0-4
}

function generateDayparts(hoursStr, baseEnergy) {
  const energy = baseEnergy || 5;

  if (!hoursStr || !hoursStr.trim()) {
    return DEFAULT_DAYPARTS.map((dp, i) => ({
      ...dp, energy: clamp(energy + [-2, 0, 1][i], 1, 10),
    }));
  }

  const match = hoursStr.match(
    /(\d{1,2}[:\.]?\d{0,2}\s*(?:am|pm)?)\s*[-\u2013\u2014to]+\s*(\d{1,2}[:\.]?\d{0,2}\s*(?:am|pm)?)/i
  );
  if (!match) {
    return DEFAULT_DAYPARTS.map((dp, i) => ({
      ...dp, energy: clamp(energy + [-2, 0, 1][i], 1, 10),
    }));
  }

  const openMin = parseTime(match[1]);
  let closeMin = parseTime(match[2]);
  const totalMinutes = closeMin <= openMin
    ? (1440 - openMin) + closeMin
    : closeMin - openMin;
  const totalHours = totalMinutes / 60;

  const segCount = totalHours <= 6 ? 2 : totalHours <= 12 ? 3 : 4;
  const segLen = Math.round(totalMinutes / segCount);

  const labels = {
    2: ['Opening', 'Peak'],
    3: ['Opening', 'Peak Hours', 'Wind Down'],
    4: ['Opening', 'Build Up', 'Peak Hours', 'Wind Down'],
  };
  const offsets = { 2: [-1, 1], 3: [-2, 0, 1], 4: [-2, -1, 1, 0] };

  const dayparts = [];
  for (let i = 0; i < segCount; i++) {
    const startMin = (openMin + i * segLen) % 1440;
    const endMin = (openMin + (i + 1) * segLen) % 1440;
    const key = labels[segCount][i].toLowerCase().replace(/\s+/g, '_');
    dayparts.push({
      key,
      label: `${labels[segCount][i]} (${timeLabel(startMin)}\u2013${timeLabel(endMin)})`,
      timeRange: `${timeLabel(startMin)}-${timeLabel(endMin)}`,
      icon: iconForTime(startMin),
      energy: clamp(energy + offsets[segCount][i], 1, 10),
    });
  }
  return dayparts;
}

function buildDesignerBrief(data) {
  const vibes = Array.isArray(data.vibes) ? data.vibes : [data.vibes].filter(Boolean);
  const energy = parseInt(data.energy, 10) || 5;
  const venueType = data.venueType || '';

  const genreScores = {};
  for (const vibe of vibes) {
    const mapping = VIBE_GENRES[vibe];
    if (!mapping) continue;
    for (const genre of mapping.genres) {
      genreScores[genre] = (genreScores[genre] || 0) + 1;
    }
  }

  const boosters = VENUE_BOOSTERS[venueType] || [];
  for (const genre of boosters) {
    genreScores[genre] = (genreScores[genre] || 0) + 0.5;
  }

  const rankedGenres = Object.entries(genreScores)
    .sort((a, b) => b[1] - a[1])
    .map(([genre]) => genre);

  const topGenres = rankedGenres.slice(0, 8);

  const bpmRanges = vibes
    .map(v => VIBE_GENRES[v]?.bpm)
    .filter(Boolean);

  const dayparts = generateDayparts(data.hours, energy);
  const daypartMap = {};
  const daypartOrder = [];
  for (const dp of dayparts) {
    daypartOrder.push(dp.key);
    daypartMap[dp.key] = {
      energy: dp.energy,
      genres: topGenres.slice(0, dp.energy >= energy ? 6 : 5),
      label: dp.label,
      icon: dp.icon,
      timeRange: dp.timeRange,
    };
  }

  return {
    topGenres,
    bpmRanges: [...new Set(bpmRanges)],
    dayparts: daypartMap,
    daypartOrder,
  };
}

// ---------------------------------------------------------------------------
// AI Playlist Recommendation System
// ---------------------------------------------------------------------------
function buildSystemPrompt(dayparts) {
  const dpInstructions = dayparts.map(dp =>
    `- "${dp.key}" \u2014 ${dp.label}: Energy ${dp.energy}/10`
  ).join('\n');
  const dpKeys = dayparts.map(dp => dp.key).join('|');

  return `You are a professional music curator for BMAsia Group. Analyze venue atmosphere briefs and recommend playlists from the Soundtrack Your Brand (SYB) catalog.

## SYB Playlist Catalog
${JSON.stringify(PLAYLIST_CATALOG)}

## Instructions
Analyze ALL customer inputs holistically: vibes, energy level, venue type, operating hours, demographics, vocal/language preferences, avoid list, mood changes, reference venues, and free-text descriptions.

Recommend 8-12 playlists distributed across these dayparts:
${dpInstructions}

Aim for 2-4 playlists per daypart. The dayparts reflect the venue's actual operating hours, so use them as-is.

## Rules
- ONLY recommend playlists from the catalog (use exact IDs)
- Respect the avoid list: never recommend matching styles
- Match vocal preferences (instrumental, mostly instrumental, etc.)
- Consider venue type (hotel playlists for hotels, etc.) but cross-match when appropriate
- matchScore: 70-99, be honest. 90+ only for excellent matches
- If mood changes are specified, reflect transitions across dayparts
- Energy levels per daypart are guidelines \u2014 adjust slightly based on mood description
- Reference the actual time segments in your reasons and designer notes

## Output (strict JSON, no markdown)
{"recommendations":[{"playlistId":"syb_xxx","daypart":"${dpKeys}","reason":"1-2 sentences referencing the time segment","matchScore":70-99}],"designerNotes":"Brief direction for the design team referencing the actual time segments"}`;
}

function buildUserMessage(data) {
  const vibes = Array.isArray(data.vibes) ? data.vibes : [data.vibes].filter(Boolean);
  const parts = [
    `Venue: ${data.venueName || 'Not specified'}`,
    `Type: ${data.venueType || 'Not specified'}`,
    `Location: ${data.location || 'Not specified'}`,
    `Operating Hours: ${data.hours || 'Not specified'}`,
    `Vibes: ${vibes.join(', ') || 'None selected'}`,
    `Energy Level: ${data.energy || '5'}/10`,
  ];
  if (data.referenceVenues) parts.push(`Reference Venues: ${data.referenceVenues}`);
  if (data.vibeDescription) parts.push(`Atmosphere Description: ${data.vibeDescription}`);
  if (data.guestProfile) parts.push(`Guest Profile: ${data.guestProfile}`);
  if (data.ageRange) parts.push(`Age Range: ${data.ageRange}`);
  if (data.nationality) parts.push(`Primary Nationality: ${data.nationality}`);
  if (data.vocals) parts.push(`Vocal Preference: ${data.vocals}`);
  if (data.musicLanguages) parts.push(`Music Languages: ${data.musicLanguages}`);
  if (data.avoidList) parts.push(`AVOID / Do Not Play: ${data.avoidList}`);
  if (data.moodChanges) parts.push(`Mood Changes: ${data.moodChanges}`);
  return parts.join('\n');
}

function deterministicMatch(data, dayparts) {
  const vibes = Array.isArray(data.vibes) ? data.vibes : [data.vibes].filter(Boolean);
  const energy = parseInt(data.energy, 10) || 5;
  const venueType = data.venueType || '';
  const avoidList = (data.avoidList || '').toLowerCase();
  const vocals = data.vocals || '';
  const venueCatMap = {
    'hotel-lobby': 'hotel', restaurant: 'restaurant', 'bar-lounge': 'bar',
    'spa-wellness': 'spa', cafe: 'cafe', 'fashion-retail': 'store',
    coworking: 'lounge', 'pool-beach': 'hotel', 'gym-fitness': 'store', qsr: 'restaurant',
  };
  const targetCat = venueCatMap[venueType] || '';
  const vibeKw = {
    relaxed: ['relax', 'chill', 'calm', 'gentle', 'soft', 'mellow', 'easy', 'soothing', 'acoustic'],
    energetic: ['energetic', 'upbeat', 'energy', 'pop', 'dance', 'hits', 'rush'],
    sophisticated: ['elegant', 'sophisticated', 'jazz', 'refined', 'grand', 'fine'],
    warm: ['warm', 'cozy', 'acoustic', 'folk', 'inviting', 'friendly'],
    trendy: ['modern', 'trendy', 'indie', 'hip', 'current', 'urban', 'fashion'],
    upbeat: ['happy', 'feel-good', 'upbeat', 'fun', 'groovy', 'sunny', 'cheerful'],
    zen: ['zen', 'ambient', 'meditation', 'nature', 'peaceful', 'mindful', 'spa'],
    romantic: ['romantic', 'intimate', 'soul', 'ballad', 'dinner', 'date'],
    luxurious: ['luxury', 'elegant', 'lounge', 'house', 'upscale', 'grand', 'boutique'],
    tropical: ['tropical', 'beach', 'reggae', 'island', 'caribbean', 'bossa', 'surf'],
    creative: ['indie', 'creative', 'alternative', 'art', 'fusion', 'world'],
    professional: ['office', 'background', 'light', 'subtle', 'focus'],
  };
  const energyCats = energy <= 3 ? ['spa', 'lounge'] : energy <= 6 ? ['cafe', 'restaurant', 'hotel', 'lounge'] : ['bar', 'store'];

  const scored = PLAYLIST_CATALOG.map(p => {
    let score = 0;
    const text = `${p.name} ${p.description}`.toLowerCase();
    if (targetCat && p.categories.includes(targetCat)) score += 3;
    for (const vibe of vibes) {
      for (const kw of (vibeKw[vibe] || [])) { if (text.includes(kw)) score += 0.5; }
    }
    if (p.categories.some(c => energyCats.includes(c))) score += 1;
    if (avoidList) {
      // Extract individual genre/style keywords from avoid phrases
      // e.g. "no hip-hop or rap, no mainstream pop" → ["hip-hop", "rap", "pop"]
      const avoidTerms = avoidList
        .replace(/\bno\b/gi, '')
        .replace(/\bhits\b/gi, '')
        .replace(/\bmainstream\b/gi, '')
        .split(/[,;]+|\b(?:and|or)\b/i)
        .map(s => s ? s.trim().toLowerCase() : '')
        .filter(s => s && s.length > 1);
      const normalizedText = text.replace(/-/g, ' ');
      for (const term of avoidTerms) {
        const normalizedTerm = term.replace(/-/g, ' ');
        if (normalizedText.includes(normalizedTerm)) score -= 10;
      }
    }
    if (vocals === 'instrumental' && /instrumental|piano|ambient|nature/.test(text)) score += 1.5;
    if (vocals === 'mostly-instrumental' && /instrumental|piano|acoustic/.test(text)) score += 0.8;
    return { ...p, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.filter(p => p.score > 0).slice(0, 12);
  const dpKeys = dayparts.map(dp => dp.key);
  const perDp = Math.ceil(top.length / dpKeys.length);

  return {
    recommendations: top.map((p, i) => {
      const dpKey = dpKeys[Math.min(Math.floor(i / perDp), dpKeys.length - 1)];
      const pText = `${p.name} ${p.description}`.toLowerCase();
      const matchedVibes = vibes.filter(v =>
        (vibeKw[v] || []).some(kw => pText.includes(kw))
      );
      const vibeStr = matchedVibes.length > 0 ? matchedVibes.join(', ') : vibes[0] || 'selected';
      const catMatch = targetCat && p.categories.includes(targetCat);
      const reason = catMatch
        ? `${p.description} — fits your ${vibeStr} ${(venueType || 'venue').replace(/-/g, ' ')}`
        : `${p.description} — complements the ${vibeStr} atmosphere`;
      return {
        playlistId: p.id,
        daypart: dpKey,
        reason,
        matchScore: Math.max(70, Math.min(95, Math.round(60 + p.score * 5))),
      };
    }),
    designerNotes: 'Generated via keyword matching. Please review and adjust.',
  };
}

function enrichRecommendations(aiResult) {
  const catalogMap = Object.fromEntries(PLAYLIST_CATALOG.map(p => [p.id, p]));
  return {
    ...aiResult,
    recommendations: aiResult.recommendations.map(rec => {
      const playlist = catalogMap[rec.playlistId];
      if (!playlist) return null;
      return {
        ...rec,
        name: playlist.name,
        description: playlist.description,
        categories: playlist.categories,
        sybUrl: playlist.sybId
          ? `https://app.soundtrack.io/music/${playlist.sybId}`
          : `https://app.soundtrack.io/search?q=${encodeURIComponent(playlist.name)}`,
      };
    }).filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// Email HTML builder
// ---------------------------------------------------------------------------
function buildPlaylistEmailSections(aiResults) {
  if (!aiResults) return '';
  let html = '';

  if (aiResults.likedPlaylists && aiResults.likedPlaylists.length > 0) {
    const likedRows = aiResults.likedPlaylists.map(p => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">
          <a href="${esc(p.sybUrl)}" style="color:#4f46e5;font-weight:600;text-decoration:none;">${esc(p.name)}</a>
          <br><span style="color:#666;font-size:12px;">${esc(p.reason)}</span>
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-transform:capitalize;">${esc(p.daypart)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600;color:#059669;">${p.matchScore}%</td>
      </tr>`).join('');

    html += `
    <tr><td style="padding:0;">
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
        <tr><td style="padding:12px 16px;background:#059669;color:#fff;font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:1px;border-radius:6px 6px 0 0;">Selected Playlists</td></tr>
        <tr><td style="padding:16px;background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 6px 6px;">
          <p style="margin:0 0 12px;color:#059669;font-weight:600;">${aiResults.likedPlaylists.length} playlist(s) selected by the customer</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;">
            <tr style="background:#f3f4f6;">
              <th style="padding:10px 12px;text-align:left;font-size:13px;color:#374151;">Playlist</th>
              <th style="padding:10px 12px;text-align:left;font-size:13px;color:#374151;">Daypart</th>
              <th style="padding:10px 12px;text-align:left;font-size:13px;color:#374151;">Match</th>
            </tr>
            ${likedRows}
          </table>
        </td></tr>
      </table>
    </td></tr>`;
  }

  if (aiResults.allRecommendations && aiResults.allRecommendations.length > 0) {
    const selIds = new Set((aiResults.likedPlaylists || []).map(p => p.playlistId));
    const allRows = aiResults.allRecommendations.map(p => {
      const sel = selIds.has(p.playlistId);
      return `
        <tr${sel ? ' style="background:#f0fdf4;"' : ''}>
          <td style="padding:6px 12px;border-bottom:1px solid #eee;font-size:14px;">${sel ? '&#10003;' : '&mdash;'}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee;">
            <a href="${esc(p.sybUrl || '#')}" style="color:#4f46e5;text-decoration:none;font-size:13px;">${esc(p.name || p.playlistId)}</a>
          </td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee;text-transform:capitalize;font-size:13px;">${esc(p.daypart)}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee;font-size:13px;">${p.matchScore}%</td>
        </tr>`;
    }).join('');

    html += `
    <tr><td style="padding:0;">
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
        <tr><td style="padding:12px 16px;background:#1a1a2e;color:#fff;font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:1px;border-radius:6px 6px 0 0;">All AI Recommendations</td></tr>
        <tr><td style="padding:16px;background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 6px 6px;">
          <p style="margin:0 0 12px;color:#666;font-size:13px;">Full AI-suggested list. Items with &#10003; were selected by the customer.</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;">
            <tr style="background:#f3f4f6;">
              <th style="padding:8px 12px;text-align:left;font-size:12px;color:#374151;width:40px;"></th>
              <th style="padding:8px 12px;text-align:left;font-size:12px;color:#374151;">Playlist</th>
              <th style="padding:8px 12px;text-align:left;font-size:12px;color:#374151;">Daypart</th>
              <th style="padding:8px 12px;text-align:left;font-size:12px;color:#374151;">Match</th>
            </tr>
            ${allRows}
          </table>
        </td></tr>
      </table>
    </td></tr>`;
  }

  return html;
}

function buildEmailHtml(data, brief, aiResults) {
  const vibes = Array.isArray(data.vibes) ? data.vibes : [data.vibes].filter(Boolean);
  const product = data.product === 'beatbreeze' ? 'Beat Breeze' : 'Soundtrack Your Brand';
  const now = new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok', dateStyle: 'full', timeStyle: 'short' });

  const venueLabels = {
    'hotel-lobby': 'Hotel Lobby', 'restaurant': 'Restaurant', 'bar-lounge': 'Bar / Lounge',
    'spa-wellness': 'Spa / Wellness', 'fashion-retail': 'Fashion Retail', 'cafe': 'Cafe',
    'gym-fitness': 'Gym / Fitness', 'pool-beach': 'Pool / Beach Club', 'qsr': 'QSR / Fast Casual',
    'coworking': 'Co-working Space', 'other': 'Other',
  };

  const daypartRow = (label, dp) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600;color:#1a1a2e;">${label}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${dp.energy}/10</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${dp.genres.join(', ')}</td>
    </tr>`;

  const section = (title, content) => `
    <tr><td style="padding:0;">
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
        <tr><td style="padding:12px 16px;background:#1a1a2e;color:#fff;font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:1px;border-radius:6px 6px 0 0;">${title}</td></tr>
        <tr><td style="padding:16px;background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 6px 6px;">${content}</td></tr>
      </table>
    </td></tr>`;

  const row = (label, value) => value ? `<tr><td style="padding:6px 0;color:#666;width:40%;vertical-align:top;">${label}</td><td style="padding:6px 0;font-weight:500;">${value}</td></tr>` : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

  <!-- Header -->
  <tr><td style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);padding:32px 24px;text-align:center;border-radius:12px 12px 0 0;">
    <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;">Music Atmosphere Brief</h1>
    <p style="margin:8px 0 0;color:#a5b4fc;font-size:13px;">${product} &bull; ${now}</p>
  </td></tr>

  <tr><td style="padding:24px 16px;background:#f9fafb;">
  <table width="100%" cellpadding="0" cellspacing="0">

  ${section('Venue Overview', `
    <table width="100%" cellpadding="0" cellspacing="0">
      ${row('Venue Name', esc(data.venueName))}
      ${row('Venue Type', venueLabels[data.venueType] || esc(data.venueType))}
      ${row('Location', esc(data.location))}
      ${row('Number of Zones', esc(data.zones))}
      ${row('Operating Hours', esc(data.hours))}
      ${row('Contact Name', esc(data.contactName))}
      ${row('Contact Email', esc(data.contactEmail))}
      ${row('Contact Phone', esc(data.contactPhone))}
    </table>
  `)}

  ${section('Atmosphere & Vibes', `
    <table width="100%" cellpadding="0" cellspacing="0">
      ${row('Selected Vibes', vibes.map(v => v.charAt(0).toUpperCase() + v.slice(1)).join(', '))}
      ${row('Energy Level', `${data.energy}/10`)}
      ${row('Reference Venues', esc(data.referenceVenues))}
      ${row('Vibe Description', esc(data.vibeDescription))}
    </table>
  `)}

  ${section('Guest Demographics', `
    <table width="100%" cellpadding="0" cellspacing="0">
      ${row('Guest Profile', esc(data.guestProfile))}
      ${row('Age Range', esc(data.ageRange))}
      ${row('Primary Nationality', esc(data.nationality))}
    </table>
  `)}

  ${section('Music Preferences', `
    <table width="100%" cellpadding="0" cellspacing="0">
      ${row('Vocals', esc(data.vocals))}
      ${row('Languages', esc(data.musicLanguages))}
      ${row('Avoid / Exclude', esc(data.avoidList))}
      ${row('Mood Changes', esc(data.moodChanges))}
    </table>
  `)}

  ${data.product === 'beatbreeze' ? section('Beat Breeze Details', `
    <table width="100%" cellpadding="0" cellspacing="0">
      ${row('AI Music Interest', esc(data.aiInterest))}
      ${row('Preferred Instruments', esc(data.instruments))}
      ${row('Brand Story', esc(data.brandStory))}
    </table>
  `) : ''}

  ${data._conversationSummary ? section('AI Conversation Summary', `
    <p style="margin:0;color:#374151;line-height:1.7;white-space:pre-wrap;">${esc(data._conversationSummary)}</p>
  `) : ''}

  ${buildPlaylistEmailSections(aiResults)}

  ${section('Designer Brief &mdash; Genre Recommendations', `
    <p style="margin:0 0 12px;color:#666;font-size:13px;">Auto-generated from customer vibe selections. Daypart energy: morning=base-2, afternoon=base, evening=base+1.</p>
    <p style="margin:0 0 8px;"><strong>Top Genres:</strong> ${brief.topGenres.join(', ')}</p>
    <p style="margin:0 0 16px;"><strong>BPM Ranges:</strong> ${brief.bpmRanges.join(', ')}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;">
      <tr style="background:#f3f4f6;">
        <th style="padding:10px 12px;text-align:left;font-size:13px;color:#374151;">Daypart</th>
        <th style="padding:10px 12px;text-align:left;font-size:13px;color:#374151;">Energy</th>
        <th style="padding:10px 12px;text-align:left;font-size:13px;color:#374151;">Recommended Genres</th>
      </tr>
      ${(brief.daypartOrder || Object.keys(brief.dayparts)).map(key => {
        const dp = brief.dayparts[key];
        return daypartRow(dp.label || key.charAt(0).toUpperCase() + key.slice(1), dp);
      }).join('')}
    </table>
  `)}

  ${section('Designer Action Items', `
    <ul style="margin:0;padding:0 0 0 20px;color:#374151;line-height:1.8;">
      <li>Review venue type and vibe selections</li>
      <li>Build ${product === 'Beat Breeze' ? 'custom AI playlist' : 'curated playlist'} based on top genres</li>
      <li>Set up daypart scheduling (${(brief.daypartOrder || Object.keys(brief.dayparts)).map(k => brief.dayparts[k].label || k).join(' / ')})</li>
      <li>Apply BPM ranges per daypart</li>
      <li>Check avoid-list and vocal/language preferences</li>
      ${data.product === 'beatbreeze' ? '<li>Review brand story for AI music generation prompts</li>' : ''}
      <li>Send draft playlist to customer for approval</li>
    </ul>
  `)}

  ${section('Raw Data (for AI reprocessing)', `
    <pre style="margin:0;font-size:11px;color:#6b7280;white-space:pre-wrap;word-break:break-all;background:#f9fafb;padding:12px;border-radius:4px;">${esc(JSON.stringify(data, null, 2))}</pre>
  `)}

  </table>
  </td></tr>

  <tr><td style="padding:20px 24px;text-align:center;background:#1a1a2e;border-radius:0 0 12px 12px;">
    <p style="margin:0;color:#a5b4fc;font-size:12px;">BMAsia Group &bull; Music Atmosphere Brief System</p>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Chat System Prompt
// ---------------------------------------------------------------------------
function buildChatSystemPrompt(language, product = 'syb') {
  const lang = language === 'th' ? 'Thai' : 'English';

  const productContext = product === 'beatbreeze'
    ? '\nThe customer has selected Beat Breeze — our royalty-free music solution. Beat Breeze offers curated royalty-free playlists with no licensing fees, ideal for businesses that want quality background music at an accessible price point. Frame your recommendations as Beat Breeze playlists.'
    : '\nThe customer has selected Soundtrack Your Brand (SYB) — our premium licensed music platform. SYB offers the largest catalog of expertly curated playlists for businesses, with fully licensed commercial music. Frame your recommendations as SYB playlists.';

  return `You are a friendly, professional music designer at BMAsia Group — Asia's leading background music company. You help venue owners and event planners find the perfect soundtrack.

## Your Personality
- Warm, enthusiastic, and knowledgeable about music for commercial spaces
- You LEAD the conversation proactively — the customer should never wonder what to say
- You speak in ${lang}
- Keep messages concise (2-4 sentences max) and conversational
- Use the customer's own words back to them when relevant
- NEVER use emojis anywhere — not in messages, not in tool call option labels, not in descriptions. Plain text only.

## Conversation Rules
- ALWAYS end every message with a clear question or call-to-action
- NEVER ask more than ONE question per message — this is critical. Do not combine a text question with a structured question in the same message.
- ALWAYS collect operating hours before calling generate_recommendations. Without hours, the system falls back to generic Morning/Afternoon/Evening dayparts which may not match the venue at all (e.g. a bar that opens at 5pm should not get "Morning" playlists). Operating hours is non-negotiable.
- If the customer gives a rich description upfront, you can skip unnecessary follow-ups — but you MUST still ask about operating hours
- Do NOT list or explain the information you need — just ask naturally, one thing at a time

## Three Conversation Modes

### Mode: "new" — New Venue Design
1. Ask what type of venue (if not already known from context)
2. Ask about the atmosphere / feeling they want
3. Ask venue name and location
4. Call research_venue to learn about the venue, property, and area (if venue name was given)
5. Ask about operating hours (REQUIRED — this drives the entire daypart schedule)
6. Ask 1-2 smart follow-ups if needed (avoid list, vocals, guest mix)
7. Call generate_recommendations when ready (include venueName, location, and hours)

### Mode: "event" — Special Event Planning
1. Ask for venue name and email on file (for verification)
2. Ask about the event: occasion, date, desired atmosphere
3. Ask about duration and any specific music requirements
4. Call generate_recommendations

### Mode: "update" — Update Existing Music
1. Ask for venue name and email on file (for verification)
2. Ask what they'd like to change and why
3. Call generate_recommendations with the adjustments

## What Information to Gather (in priority order)
1. Venue type (hotel, restaurant, bar, spa, cafe, etc.)
2. Atmosphere description (the richest signal — vibes, mood, feeling)
3. Venue name and location — ask naturally, e.g. "What's the name of your bar?"
   - Then follow up about location: "And is [name] inside a hotel or resort, or is it a standalone venue?"
   - If they already mentioned both (e.g. "Horizon at the Hilton Pattaya"), acknowledge and move on
   - Location means: which property or building is it in? Our design team needs this context.
   - After learning name + location, call research_venue to gather context about the venue, property, and area
4. Operating hours (REQUIRED for daypart segmentation) — ask as its own standalone question, e.g. "What time does [name] open and close?"
   - NEVER combine this question with another question or a structured question in the same message
   - The entire schedule design depends on this — without hours, the customer gets useless generic dayparts
5. Things to avoid (genres, styles, explicit content)
6. Vocal/language preferences (if relevant)
7. Guest demographics (if relevant)
8. Reference venues (if they mention any)

Extract structured vibes from the customer's natural language:
- "chill" / "relaxed" / "calm" → relaxed
- "upbeat" / "fun" / "lively" → upbeat or energetic
- "classy" / "elegant" / "refined" → sophisticated
- "cozy" / "inviting" → warm
- "modern" / "hip" / "cool" → trendy
- "peaceful" / "serene" → zen
- "intimate" / "date night" → romantic
- "upscale" / "premium" → luxurious
- "beachy" / "island" → tropical
- "artsy" / "unique" → creative
- "corporate" / "office" → professional

Infer energy level 1-10 from their language:
- "quiet", "subtle", "background" → 2-3
- "relaxed", "easy", "gentle" → 3-4
- "moderate", "balanced" → 5-6
- "lively", "fun", "upbeat" → 6-7
- "energetic", "pumping", "party" → 8-9
${productContext}

## Structured Questions (Tool: ask_structured_question)
You have a tool to present numbered options to the customer. Use it when:
- Asking about venue type, vibe/atmosphere (set allowMultiple: true), energy level, vocal preference, what music to avoid (set allowSkip: true)
- The question has KNOWN likely answers that can be listed as 3-6 options

Do NOT use it for:
- Open-ended questions ("Tell me about your venue's atmosphere")
- Simple yes/no questions (just ask in text)
- Your first greeting or warm-up message
- Follow-up questions where the user's previous answer already narrows things down enough

When using it, always set allowCustom to true so the customer can type something different. Use questionIndex and totalQuestions when you plan a series (e.g. venue type → vibe → energy).
NEVER use emojis in option labels or descriptions. Keep them clean text only (e.g. "Hotel Lobby" not "🏨 Hotel Lobby").

After the customer answers a structured question, continue the conversation naturally in text — acknowledge their choice, maybe add a brief comment, then ask your next question (structured or text, whichever fits).

## Venue Research (Tool: research_venue)
After learning the venue name and location, call research_venue with 2-3 search queries to learn about:
1. The venue itself (concept, reviews, photos, menu, atmosphere)
2. The property/hotel/resort it belongs to (brand, guest profile, style)
3. The city/area (nightlife scene, tourist profile, local culture)

Example queries for "Horizon at the Hilton Pattaya":
- "Horizon rooftop bar Hilton Pattaya"
- "Hilton Pattaya hotel"
- "Pattaya nightlife bars"

Use the research findings to:
- Share a brief relevant insight with the customer (shows you did your homework)
- Inform your music recommendations (e.g. if it's a sunset lounge, factor that into the vibe)
- Better understand the guest profile (e.g. resort tourists vs. local regulars)

If research returns no useful results, that's fine — just continue the conversation.

## After Generating Recommendations
After calling the tool, present the results conversationally:
- Briefly introduce what you've designed and how the schedule flows through their operating hours
- Tell them to click "Preview on SYB" to listen to each playlist
- Ask them to select the ones they like with "Add to brief"
- Once they're happy, they can click "Review your music schedule" to see a summary before sending to the design team
- If they want changes, adjust and regenerate

## Available Venue Types
hotel-lobby, restaurant, bar-lounge, spa-wellness, fashion-retail, cafe, gym-fitness, pool-beach, qsr, coworking`;
}

// Tool definition for Claude to call when ready to generate recommendations
const RECOMMEND_TOOL = {
  name: 'generate_recommendations',
  description: 'Generate playlist recommendations for the customer based on gathered information. Call this when you have enough context about the venue and desired atmosphere (at minimum: venue type and atmosphere/vibe description). Do NOT call this until you have asked at least one question about the atmosphere.',
  input_schema: {
    type: 'object',
    properties: {
      venueName: { type: 'string', description: 'Name of the venue (if mentioned by customer)' },
      location: { type: 'string', description: 'Where the venue is located — include the property/building (e.g. "Hilton Hotel, Pattaya") if part of a hotel/resort/mall, or just the city if standalone (e.g. "Bangkok, standalone")' },
      venueType: {
        type: 'string',
        description: 'Venue type key',
        enum: ['hotel-lobby', 'restaurant', 'bar-lounge', 'spa-wellness', 'fashion-retail', 'cafe', 'gym-fitness', 'pool-beach', 'qsr', 'coworking', 'other'],
      },
      vibes: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['relaxed', 'energetic', 'sophisticated', 'warm', 'trendy', 'upbeat', 'zen', 'romantic', 'luxurious', 'tropical', 'creative', 'professional'],
        },
        description: 'Extracted vibes from conversation (1-3)',
      },
      energy: {
        type: 'number',
        description: 'Energy level 1-10 inferred from conversation',
        minimum: 1,
        maximum: 10,
      },
      hours: {
        type: 'string',
        description: 'Operating hours (e.g., "17:00 - 02:00", "9am - 11pm")',
      },
      referenceVenues: { type: 'string', description: 'Reference venues mentioned by customer' },
      avoidList: { type: 'string', description: 'Genres or styles to avoid, as clean comma-separated terms (e.g. "pop, hip-hop, rap, EDM"). Extract just the genre keywords, not full phrases like "no mainstream pop hits".' },
      vocals: {
        type: 'string',
        description: 'Vocal preference',
        enum: ['instrumental-only', 'mostly-instrumental', 'mix', 'mostly-vocals', 'no-preference', ''],
      },
      musicLanguages: { type: 'string', description: 'Preferred music languages' },
      guestProfile: { type: 'string', description: 'Guest demographics description' },
      ageRange: { type: 'string', description: 'Primary age range' },
      nationality: { type: 'string', description: 'Primary nationality of guests' },
      moodChanges: { type: 'string', description: 'How mood should change through the day' },
      eventDescription: { type: 'string', description: 'For events: description of the event, occasion, date' },
    },
    required: ['venueType', 'vibes', 'energy'],
  },
};

// ---------------------------------------------------------------------------
// Structured Question Tool — presented as UI questionnaire in client
// ---------------------------------------------------------------------------
const STRUCTURED_QUESTION_TOOL = {
  name: 'ask_structured_question',
  description: 'Present a structured question with numbered options to the customer. Use for questions with known likely answers (venue type, vibe, energy level, vocal preference, avoidances). Do NOT use for open-ended questions, yes/no questions, or the first greeting. Only present ONE question per call.',
  input_schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question text to display' },
      options: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Option text the user sees' },
            value: { type: 'string', description: 'Semantic value for the conversation' },
            description: { type: 'string', description: 'Optional short description below the label' },
          },
          required: ['label', 'value'],
        },
        description: '2-8 options recommended',
      },
      allowCustom: { type: 'boolean', description: 'Show "Something else" free-text input. Default true.' },
      allowSkip: { type: 'boolean', description: 'Show a Skip button. Default false.' },
      allowMultiple: { type: 'boolean', description: 'Allow selecting multiple options (e.g. vibes). Default false.' },
      questionIndex: { type: 'number', description: 'Current question number in a series (e.g. 1). Omit if standalone.' },
      totalQuestions: { type: 'number', description: 'Total questions in the series (e.g. 3). Omit if standalone.' },
    },
    required: ['question', 'options'],
  },
};

const RESEARCH_VENUE_TOOL = {
  name: 'research_venue',
  description: 'Search the web for information about the venue, its location, and the property it belongs to. Call this AFTER learning the venue name and location, BEFORE asking about operating hours. This helps you understand the venue concept, brand, guest profile, and local context for better music design.',
  input_schema: {
    type: 'object',
    properties: {
      venueName: { type: 'string', description: 'Name of the venue' },
      location: { type: 'string', description: 'Location/property (e.g. "Hilton Hotel, Pattaya")' },
      searchQueries: {
        type: 'array',
        items: { type: 'string' },
        description: 'Up to 3 search queries to research the venue context. Example: ["Horizon rooftop bar Hilton Pattaya", "Hilton Pattaya hotel", "Pattaya nightlife"]',
        maxItems: 3,
      },
    },
    required: ['venueName', 'searchQueries'],
  },
};

const ALL_TOOLS = [RECOMMEND_TOOL, STRUCTURED_QUESTION_TOOL, RESEARCH_VENUE_TOOL];

// ---------------------------------------------------------------------------
// Brave Search — venue research
// ---------------------------------------------------------------------------
async function executeVenueResearch(toolInput) {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    return { success: false, summary: 'Web search is not configured (no BRAVE_SEARCH_API_KEY). Continue without research.' };
  }

  const queries = (toolInput.searchQueries || []).slice(0, 3);
  const results = [];

  for (const query of queries) {
    try {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&text_decorations=false`;
      const resp = await fetch(url, {
        headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': apiKey },
      });
      if (!resp.ok) {
        results.push({ query, snippets: [`Search failed: ${resp.status}`] });
        continue;
      }
      const data = await resp.json();
      const snippets = (data.web?.results || []).slice(0, 5).map(r =>
        `${r.title}: ${r.description || ''}`
      );
      results.push({ query, snippets });
    } catch (err) {
      results.push({ query, snippets: [`Search error: ${err.message}`] });
    }
  }

  // Format results as a text summary
  let summary = '';
  for (const r of results) {
    summary += `\n### Search: "${r.query}"\n`;
    for (const s of r.snippets) {
      summary += `- ${s}\n`;
    }
  }

  return {
    success: true,
    venueName: toolInput.venueName,
    location: toolInput.location || '',
    summary: summary.trim() || 'No results found.',
  };
}

// Execute the recommendation tool server-side
function executeRecommendationTool(toolInput, product = 'syb') {
  const data = {
    venueName: toolInput.venueName || 'Venue',
    venueType: toolInput.venueType || '',
    location: toolInput.location || '',
    hours: toolInput.hours || '',
    vibes: toolInput.vibes || ['relaxed'],
    energy: toolInput.energy || 5,
    referenceVenues: toolInput.referenceVenues || '',
    avoidList: toolInput.avoidList || '',
    vocals: toolInput.vocals || '',
    musicLanguages: toolInput.musicLanguages || '',
    guestProfile: toolInput.guestProfile || '',
    ageRange: toolInput.ageRange || '',
    nationality: toolInput.nationality || '',
    moodChanges: toolInput.moodChanges || '',
  };

  const energy = parseInt(data.energy, 10) || 5;
  const dayparts = generateDayparts(data.hours, energy);
  const result = deterministicMatch(data, dayparts);
  const enriched = enrichRecommendations(result);

  return { dayparts, ...enriched, extractedBrief: data, product };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Chat endpoint with SSE streaming
const chatLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: { error: 'Too many chat messages. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.post('/api/chat', chatLimiter, async (req, res) => {
  const { message, history, mode, language, product, pendingToolUse } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Message is required.' });
  }

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const sendSSE = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  try {
    if (!anthropic) {
      sendSSE('text', { content: "I'm sorry, the AI service is temporarily unavailable. Please try again later." });
      sendSSE('done', {});
      return res.end();
    }

    // Build messages array from history
    const messages = [];
    if (Array.isArray(history)) {
      for (const msg of history) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          messages.push({ role: msg.role, content: msg.content });
        }
      }
    }
    messages.push({ role: 'user', content: message });

    const systemPrompt = buildChatSystemPrompt(language, product);

    // First API call — may result in tool use or direct text
    const response = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 1500,
      system: systemPrompt,
      tools: ALL_TOOLS,
      messages,
    });

    // Helper: handle a completed API response (tool use or text)
    async function handleResponse(resp, msgs) {
      if (resp.stop_reason === 'tool_use') {
        const toolUseBlock = resp.content.find(b => b.type === 'tool_use');
        const textBlocks = resp.content.filter(b => b.type === 'text');

        // Stream any text before the tool call
        for (const tb of textBlocks) {
          if (tb.text.trim()) {
            sendSSE('text', { content: tb.text });
          }
        }

        if (toolUseBlock.name === 'ask_structured_question') {
          // Relay structured question to client — response ends here
          sendSSE('structured_question', {
            toolUseId: toolUseBlock.id,
            assistantContent: resp.content,
            ...toolUseBlock.input,
          });
          return; // Don't send 'done' yet — caller handles it
        }

        if (toolUseBlock.name === 'research_venue') {
          // Execute venue research via Brave Search
          const researchResult = await executeVenueResearch(toolUseBlock.input);

          // Send result back to Claude so it can continue the conversation
          const researchMessages = [
            ...msgs,
            { role: 'assistant', content: resp.content },
            {
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: toolUseBlock.id,
                content: researchResult.success
                  ? `Research results for ${researchResult.venueName}:\n${researchResult.summary}\n\nUse this context to inform your music recommendations. Share a brief, relevant insight with the customer (1 sentence max), then continue the conversation — ask about operating hours next.`
                  : `${researchResult.summary}\nContinue the conversation — ask about operating hours next.`,
              }],
            },
          ];

          // Claude continues with the research context
          const researchResp = await anthropic.messages.create({
            model: AI_MODEL,
            max_tokens: 1500,
            system: systemPrompt,
            tools: ALL_TOOLS,
            messages: researchMessages,
          });

          // Recursively handle the follow-up (could be text or another tool call)
          await handleResponse(researchResp, researchMessages);
          return;
        }

        if (toolUseBlock.name === 'generate_recommendations') {
          // Execute the recommendation tool
          const toolResult = executeRecommendationTool(toolUseBlock.input, product);

          sendSSE('recommendations', {
            recommendations: toolResult.recommendations,
            dayparts: toolResult.dayparts,
            designerNotes: toolResult.designerNotes,
            extractedBrief: toolResult.extractedBrief,
          });

          // Build tool result summary for Claude
          const playlistSummary = toolResult.recommendations.map(r =>
            `- ${r.name} (${r.daypart}, ${r.matchScore}% match)`
          ).join('\n');
          const daypartSummary = toolResult.dayparts.map(d => d.label).join(', ');

          const followUpMessages = [
            ...msgs,
            { role: 'assistant', content: resp.content },
            {
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: toolUseBlock.id,
                content: `Generated ${toolResult.recommendations.length} playlist recommendations across ${toolResult.dayparts.length} dayparts (${daypartSummary}):\n${playlistSummary}\n\nThe playlist cards are now displayed to the customer with preview links and "Add to brief" toggle buttons. Present these results conversationally — briefly introduce what you designed and how the schedule flows through their operating hours. Invite the customer to listen and select their favorites. Do NOT list the playlists again (they can see the cards). Keep it to 2-3 sentences.`,
              }],
            },
          ];

          // Second API call — Claude presents the results
          const stream = anthropic.messages.stream({
            model: AI_MODEL,
            max_tokens: 500,
            system: systemPrompt,
            tools: ALL_TOOLS,
            messages: followUpMessages,
          });

          for await (const event of stream) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              sendSSE('text_delta', { content: event.delta.text });
            }
          }
        }
      } else {
        // No tool use — stream conversational response word by word
        for (const block of resp.content) {
          if (block.type === 'text' && block.text.trim()) {
            const words = block.text.split(/(\s+)/);
            for (const word of words) {
              sendSSE('text_delta', { content: word });
            }
          }
        }
      }
    }

    // Handle pending tool use round-trip (user answered a structured question)
    if (pendingToolUse && pendingToolUse.toolUseId && pendingToolUse.assistantContent) {
      messages.pop(); // remove the user message we just added as plain text
      messages.push({ role: 'assistant', content: pendingToolUse.assistantContent });
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: pendingToolUse.toolUseId,
          content: `The customer selected: "${message}"`,
        }],
      });

      // API call with tool result — Claude continues the conversation
      const toolResponse = await anthropic.messages.create({
        model: AI_MODEL,
        max_tokens: 1500,
        system: systemPrompt,
        tools: ALL_TOOLS,
        messages,
      });

      await handleResponse(toolResponse, messages);
    } else {
      // Normal flow: first API call
      await handleResponse(response, messages);
    }

    sendSSE('done', {});
    res.end();
  } catch (err) {
    console.error('Chat error:', err);
    sendSSE('error', { content: 'Something went wrong. Please try again.' });
    sendSSE('done', {});
    res.end();
  }
});
app.post('/api/recommend', recommendLimiter, async (req, res) => {
  try {
    const data = req.body;
    if (!data.vibes || (Array.isArray(data.vibes) && data.vibes.length === 0)) {
      return res.status(400).json({ error: 'At least one vibe is required.' });
    }

    const energy = parseInt(data.energy, 10) || 5;
    const dayparts = generateDayparts(data.hours, energy);

    let result;
    if (anthropic) {
      try {
        const response = await anthropic.messages.create({
          model: AI_MODEL,
          max_tokens: 1500,
          system: buildSystemPrompt(dayparts),
          messages: [{ role: 'user', content: buildUserMessage(data) }],
        });
        const text = response.content[0].text.trim();
        const jsonStr = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
        result = JSON.parse(jsonStr);
      } catch (aiErr) {
        console.error('AI recommendation error, falling back:', aiErr.message);
        result = deterministicMatch(data, dayparts);
      }
    } else {
      result = deterministicMatch(data, dayparts);
    }

    const enriched = enrichRecommendations(result);
    res.json({ success: true, dayparts, ...enriched });
  } catch (err) {
    console.error('Recommend error:', err);
    res.status(500).json({ error: 'Failed to generate recommendations.' });
  }
});

app.post('/submit', submitLimiter, async (req, res) => {
  try {
    const data = req.body;

    // Honeypot check
    if (data.website) {
      return res.json({ success: true });
    }

    // Basic validation — chat-based submissions use venueName from form
    if (!data.venueName) {
      return res.status(400).json({ error: 'Venue name is required.' });
    }

    const aiResults = {
      likedPlaylists: data.likedPlaylists || [],
      allRecommendations: data.allRecommendations || [],
    };
    const daypartsMetadata = data.daypartsMetadata;
    const extractedBrief = data.extractedBrief;
    const conversationSummary = data.conversationSummary;
    delete data.likedPlaylists;
    delete data.allRecommendations;
    delete data.daypartsMetadata;
    delete data.extractedBrief;
    delete data.conversationSummary;

    // Merge extracted brief from chat into data for email builder
    if (extractedBrief) {
      data.vibes = data.vibes || extractedBrief.vibes || ['relaxed'];
      data.venueType = data.venueType || extractedBrief.venueType || '';
      data.energy = data.energy || extractedBrief.energy || 5;
      data.hours = data.hours || extractedBrief.hours || '';
      data.referenceVenues = data.referenceVenues || extractedBrief.referenceVenues || '';
      data.avoidList = data.avoidList || extractedBrief.avoidList || '';
      data.vocals = data.vocals || extractedBrief.vocals || '';
      data.musicLanguages = data.musicLanguages || extractedBrief.musicLanguages || '';
      data.guestProfile = data.guestProfile || extractedBrief.guestProfile || '';
      data.ageRange = data.ageRange || extractedBrief.ageRange || '';
      data.nationality = data.nationality || extractedBrief.nationality || '';
      data.moodChanges = data.moodChanges || extractedBrief.moodChanges || '';
    }

    // Ensure vibes is an array for buildDesignerBrief
    if (!data.vibes) data.vibes = ['relaxed'];

    const brief = buildDesignerBrief(data);

    // Override brief dayparts with metadata if available
    if (daypartsMetadata && Array.isArray(daypartsMetadata) && daypartsMetadata.length > 0) {
      const energy = parseInt(data.energy, 10) || 5;
      const dpMap = {};
      const dpOrder = [];
      for (const dp of daypartsMetadata) {
        dpOrder.push(dp.key);
        dpMap[dp.key] = {
          energy: dp.energy,
          genres: brief.topGenres.slice(0, dp.energy >= energy ? 6 : 5),
          label: dp.label,
          icon: dp.icon,
          timeRange: dp.timeRange,
        };
      }
      brief.dayparts = dpMap;
      brief.daypartOrder = dpOrder;
    }

    // Add conversation summary to data for email
    if (conversationSummary) {
      data._conversationSummary = conversationSummary;
    }

    const html = buildEmailHtml(data, brief, aiResults);

    const product = data.product === 'beatbreeze' ? 'Beat Breeze' : 'SYB';
    const subject = `Music Brief: ${data.venueName} (${product})`;

    await transporter.sendMail({
      from: `"BMAsia Music Brief" <${GMAIL_USER}>`,
      to: RECIPIENT_EMAIL,
      subject,
      html,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).json({ error: 'Failed to send brief. Please try again.' });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`BMAsia Music Brief running on http://localhost:${PORT}`);
});
