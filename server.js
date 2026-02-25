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

// ---------------------------------------------------------------------------
// PostgreSQL (optional — graceful fallback if DATABASE_URL not set)
// ---------------------------------------------------------------------------
const { Pool } = require('pg');
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 })
  : null;

// Auto-create tables on startup
if (pool) {
  pool.query(`
    CREATE TABLE IF NOT EXISTS briefs (
      id SERIAL PRIMARY KEY,
      venue_name VARCHAR(255) NOT NULL,
      venue_type VARCHAR(50),
      location TEXT,
      contact_name VARCHAR(255),
      contact_email VARCHAR(255),
      product VARCHAR(20) DEFAULT 'syb',
      liked_playlist_ids TEXT[],
      conversation_summary TEXT,
      raw_data JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS venues (
      id SERIAL PRIMARY KEY,
      venue_name VARCHAR(255) UNIQUE NOT NULL,
      location TEXT,
      venue_type VARCHAR(50),
      syb_account_id VARCHAR(255),
      latest_brief_id INTEGER REFERENCES briefs(id),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_venues_name ON venues(venue_name);
    CREATE INDEX IF NOT EXISTS idx_briefs_venue ON briefs(venue_name);
    CREATE INDEX IF NOT EXISTS idx_briefs_email ON briefs(contact_email);
  `).then(() => console.log('Database tables ready'))
    .catch(err => console.error('Database init error:', err.message));
}

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
    'hotel-lobby': ['hotel', 'lounge'],
    restaurant: ['restaurant'],
    'bar-lounge': ['bar', 'lounge'],
    'spa-wellness': ['spa'],
    cafe: ['cafe', 'lounge'],
    'fashion-retail': ['store'],
    coworking: ['lounge'],
    'pool-beach': ['hotel', 'lounge'],
    'gym-fitness': ['store'],
    qsr: ['restaurant'],
  };
  const targetCats = venueCatMap[venueType] || [];
  const vibeKw = {
    relaxed: ['relax', 'chill', 'calm', 'gentle', 'soft', 'mellow', 'easy', 'soothing', 'acoustic'],
    energetic: ['energetic', 'upbeat', 'energy', 'pop', 'dance', 'hits', 'rush'],
    sophisticated: ['elegant', 'sophisticated', 'refined', 'grand', 'fine', 'polished', 'tasteful'],
    warm: ['warm', 'cozy', 'acoustic', 'folk', 'inviting', 'friendly'],
    trendy: ['modern', 'trendy', 'indie', 'hip', 'current', 'urban', 'fashion'],
    upbeat: ['happy', 'feel-good', 'upbeat', 'fun', 'groovy', 'sunny', 'cheerful'],
    zen: ['zen', 'ambient', 'meditation', 'nature', 'peaceful', 'mindful', 'spa'],
    romantic: ['romantic', 'intimate', 'soul', 'ballad', 'dinner', 'date'],
    luxurious: ['luxury', 'elegant', 'lounge', 'upscale', 'grand', 'boutique', 'premium'],
    tropical: ['tropical', 'beach', 'reggae', 'island', 'caribbean', 'bossa', 'surf'],
    creative: ['indie', 'creative', 'alternative', 'art', 'fusion', 'world'],
    professional: ['office', 'background', 'light', 'subtle', 'focus'],
  };
  const genreHints = data.genreHints || [];

  const scored = PLAYLIST_CATALOG.map(p => {
    let score = 0;
    const text = `${p.name} ${p.description}`.toLowerCase();
    const catMatches = targetCats.filter(c => p.categories.includes(c)).length;
    if (catMatches > 0) score += 2 + catMatches;
    for (const vibe of vibes) {
      for (const kw of (vibeKw[vibe] || [])) { if (text.includes(kw)) score += 0.5; }
    }
    for (const hint of genreHints) {
      if (text.includes(hint.toLowerCase())) score += 2;
    }
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
    return { ...p, baseScore: score, text };
  });

  // Per-daypart scoring: adjust for energy, pick top N, dedup across dayparts
  const usedIds = new Set();
  const perDp = Math.ceil(12 / dayparts.length);
  const allRecs = [];

  for (const dp of dayparts) {
    const dpEnergyCats = dp.energy <= 3 ? ['spa', 'lounge']
      : dp.energy <= 6 ? ['cafe', 'restaurant', 'hotel', 'lounge']
      : ['bar', 'store', 'lounge'];

    const dpScored = scored.map(p => ({
      ...p,
      dpScore: p.baseScore + (p.categories.some(c => dpEnergyCats.includes(c)) ? 1 : 0),
    }));
    dpScored.sort((a, b) => b.dpScore - a.dpScore);

    let picked = 0;
    for (const p of dpScored) {
      if (picked >= perDp || p.dpScore <= 0) break;
      if (usedIds.has(p.id)) continue;
      usedIds.add(p.id);

      const matchedVibes = vibes.filter(v =>
        (vibeKw[v] || []).some(kw => p.text.includes(kw))
      );
      const vibeStr = matchedVibes.length > 0 ? matchedVibes.join(', ') : vibes[0] || 'selected';
      const catMatch = targetCats.some(c => p.categories.includes(c));
      const reason = catMatch
        ? `${p.description} — fits your ${vibeStr} ${(venueType || 'venue').replace(/-/g, ' ')}`
        : `${p.description} — complements the ${vibeStr} atmosphere`;

      allRecs.push({ playlistId: p.id, daypart: dp.key, reason, rawScore: p.dpScore });
      picked++;
    }
  }

  // Normalize scores relative to best in batch
  const maxRaw = Math.max(...allRecs.map(r => r.rawScore), 1);

  return {
    recommendations: allRecs.map(r => ({
      playlistId: r.playlistId,
      daypart: r.daypart,
      reason: r.reason,
      matchScore: Math.round(55 + (r.rawScore / maxRaw) * 40),
    })),
    designerNotes: 'Generated via keyword matching with AI genre direction. Please review and adjust.',
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

  const hasZones = aiResults.likedPlaylists?.some(p => p.zone);

  if (aiResults.likedPlaylists && aiResults.likedPlaylists.length > 0) {
    let likedContent = '';

    if (hasZones) {
      // Group by zone
      const zoneGroups = {};
      for (const p of aiResults.likedPlaylists) {
        const z = p.zone || 'General';
        if (!zoneGroups[z]) zoneGroups[z] = [];
        zoneGroups[z].push(p);
      }
      for (const [zoneName, playlists] of Object.entries(zoneGroups)) {
        likedContent += `<p style="margin:12px 0 6px;font-weight:700;color:#EFA634;font-size:14px;">${esc(zoneName)}</p>`;
        likedContent += `<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;margin-bottom:12px;">
          <tr style="background:#f3f4f6;">
            <th style="padding:10px 12px;text-align:left;font-size:13px;color:#374151;">Playlist</th>
            <th style="padding:10px 12px;text-align:left;font-size:13px;color:#374151;">Daypart</th>
            <th style="padding:10px 12px;text-align:left;font-size:13px;color:#374151;">Match</th>
          </tr>
          ${playlists.map(p => `<tr>
            <td style="padding:8px 12px;border-bottom:1px solid #eee;">
              <a href="${esc(p.sybUrl)}" style="color:#4f46e5;font-weight:600;text-decoration:none;">${esc(p.name)}</a>
              <br><span style="color:#666;font-size:12px;">${esc(p.reason)}</span>
            </td>
            <td style="padding:8px 12px;border-bottom:1px solid #eee;text-transform:capitalize;">${esc(p.daypart)}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600;color:#059669;">${p.matchScore}%</td>
          </tr>`).join('')}
        </table>`;
      }
    } else {
      // Single zone — original layout
      likedContent = `<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;">
        <tr style="background:#f3f4f6;">
          <th style="padding:10px 12px;text-align:left;font-size:13px;color:#374151;">Playlist</th>
          <th style="padding:10px 12px;text-align:left;font-size:13px;color:#374151;">Daypart</th>
          <th style="padding:10px 12px;text-align:left;font-size:13px;color:#374151;">Match</th>
        </tr>
        ${aiResults.likedPlaylists.map(p => `<tr>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;">
            <a href="${esc(p.sybUrl)}" style="color:#4f46e5;font-weight:600;text-decoration:none;">${esc(p.name)}</a>
            <br><span style="color:#666;font-size:12px;">${esc(p.reason)}</span>
          </td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;text-transform:capitalize;">${esc(p.daypart)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600;color:#059669;">${p.matchScore}%</td>
        </tr>`).join('')}
      </table>`;
    }

    html += `
    <tr><td style="padding:0;">
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
        <tr><td style="padding:12px 16px;background:#059669;color:#fff;font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:1px;border-radius:6px 6px 0 0;">Selected Playlists${hasZones ? ' (Multi-Zone)' : ''}</td></tr>
        <tr><td style="padding:16px;background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 6px 6px;">
          <p style="margin:0 0 12px;color:#059669;font-weight:600;">${aiResults.likedPlaylists.length} playlist(s) selected by the customer</p>
          ${likedContent}
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

  return `You are a senior music designer at BMAsia Group — Asia's leading background music company. You design soundtracks for venues across Asia.

## Your Expertise
You think like a professional music designer, not a form-filler:
- ENERGY ARC: How music should evolve through the guest journey (arrival, settling in, peak experience, wind down). Every great venue has a musical story arc.
- GENRE INTELLIGENCE: Genre depends on full context, not single keywords. "Sophisticated" could mean jazz piano in a hotel lobby, deep house at a rooftop bar, or neo-soul at a cocktail lounge. NEVER default to cliches.
- DEMOGRAPHIC AWARENESS: A 25-35yo international crowd wants different music than a 50yo local business crowd, even in the same venue type.
- F&B & ENTERTAINMENT CONTEXT: A bar with DJs needs pre-DJ sets for earlier hours. A wine bar has different energy than a craft cocktail bar. A beachside restaurant has different needs than a fine dining room.

## Your Personality
- Warm but expert — you know more about venue music than the customer does
- You LEAD the conversation proactively — the customer should never wonder what to say next
- You speak in ${lang}
- Keep messages concise (2-4 sentences max) and conversational
- Use the customer's own words back to them when relevant
- NEVER use emojis anywhere — not in messages, not in tool call option labels, not in descriptions. Plain text only.
- ENERGY ARC STORYTELLING: Every great venue has a musical story arc. When presenting recommendations, narrate the energy journey: how music transitions from the opening mood through the build-up, hits the peak, then winds down. The schedule is a designed experience, not a list.
- CREATIVE RISK: When a customer seems open to it — uses words like "unique", "different", "surprise me", shows passion for music — push boundaries. Suggest one unexpected playlist or genre direction. Frame it as: "Most designers would not suggest this, but I think it could work because..." Read the room — a conservative hotel GM does not want experimental electronic.

## Conversation Rules
- ALWAYS end every message with a clear question or call-to-action
- NEVER ask more than ONE question per message — this is critical. When you call ask_structured_question, the structured card IS your question. Your text in that same turn must ONLY contain acknowledgment or commentary about the previous answer — do NOT write the question in your text. The card handles the question.
- ALWAYS collect operating hours before calling generate_recommendations. Without hours, the system falls back to generic Morning/Afternoon/Evening dayparts which may not match the venue at all (e.g. a bar that opens at 5pm should not get "Morning" playlists). Operating hours is non-negotiable.
- If the customer gives a rich description upfront, you can skip unnecessary follow-ups — but you MUST still ask about operating hours
- Do NOT list or explain the information you need — just ask naturally, one thing at a time
- NEVER assume vocal preference. Always ask explicitly before generating recommendations. Getting this wrong means an entire schedule of music the customer doesn't want.
- Do NOT repeat a question you already asked. If research results confirm something you were about to ask, acknowledge the information and move on to the next question instead.

## Three Conversation Modes

### Mode: "new" — New Venue Design

Phase 1 — UNDERSTAND (2-3 exchanges):
1. Ask what type of venue using ask_structured_question tool (unless already clear from context). Your greeting text should NOT contain the venue type question — the card handles it.
2. Ask about the experience they want to create — use an open-ended question like "Paint me a picture — when a guest walks in, what should they feel?" This is your richest signal. Do NOT use a structured question here.
3. Ask venue name and location naturally. If they give both (e.g. "Horizon at the Hilton Pattaya"), acknowledge and move on.
4. Call research_venue with 3-4 search queries to learn about the venue, property, and area.
4b. For SYB product only: call lookup_existing_client with the venue name. You can call this alongside research_venue. If the client is found in SYB, welcome them back and reference their zone names. If they have multiple zones, ask which ones we are working on. If not found, continue silently as a new client — do NOT mention the lookup.

Phase 2 — DIG DEEPER (2-4 exchanges):
5. Share a design insight from your research (a conclusion, not facts — see "Using Venue Research" below). Then ask about operating hours as a standalone question.
5b. MULTI-ZONE DETECTION: For hotels, large venues, or when research/SYB lookup shows multiple areas, ask: "Does your venue have different areas that need their own music identity?" If yes, ask which areas/zones they want to design for. For existing SYB clients, zone names come from the lookup — reference them. For each zone, you will need to understand its unique vibe and energy — ask about each zone one at a time. You do NOT need separate operating hours per zone unless they differ significantly.
6. Ask ONE expert follow-up question based on what you have learned so far. Choose the most impactful one:
   - For bars/lounges: "Who are your typical guests — age range, local crowd or tourists, after-work drinks or nightlife destination?"
   - If they have DJs or live music (from research or conversation): "What style do your DJs usually play, and what times do they come on?"
   - For restaurants: "What is the dining concept and cuisine — and is there a bar area that needs a different energy?"
   - For hotels: "What is the brand positioning — business hotel, luxury resort, or boutique property?"
   - For any venue: "Are there any artists, venues, or playlists whose sound you love? This tells me more than any description."
7. Ask about vocal preference using ask_structured_question tool. Your text should ONLY be a brief comment or transition (e.g. "That helps me narrow the direction.") — the structured card handles the actual question. NEVER write the vocal preference question in your text. NEVER assume instrumental or vocal without asking.
8. Ask about things to avoid using ask_structured_question tool (set allowSkip: true, allowMultiple: true). Again, your text should ONLY be a brief transition — do NOT write "are there any genres to avoid?" or similar in your text. The card is the question. This step is optional — if avoidances are already clear from conversation, skip it.
8b. WEEKDAY vs WEEKEND: For bars, clubs, restaurants, and venues where weekends have a different energy than weekdays, ask: "Should weekends have a different vibe — more energy, different style?" If yes, note the weekend adjustments. Skip this for venues that operate the same every day (spas, hotels, retail).

Phase 3 — DESIGN:
9. Call generate_recommendations with all gathered context. You MUST include genreHints based on your expert synthesis of the entire conversation and research. The genreHints field is the most important signal you send to the matching algorithm.
   - For multi-zone venues: include the zones array with per-zone vibes, energy, genreHints (and hours if different).
   - For weekday/weekend variation: include weekendMode with adjusted energy, vibes, and genreHints.

### Mode: "event" — Special Event Planning
1. Ask for venue name and email on file (for verification)
2. Ask about the event: occasion, date, desired atmosphere
3. Ask about duration and any specific music requirements
4. Call generate_recommendations with genreHints

### Mode: "update" — Update Existing Music
1. Ask for venue name and email on file (for verification)
2. Ask what they'd like to change and why
3. Call generate_recommendations with genreHints reflecting the adjustment

## Vibe Extraction
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

## Energy Inference
Infer energy level 1-10 from their language:
- "quiet", "subtle", "background" → 2-3
- "relaxed", "easy", "gentle" → 3-4
- "moderate", "balanced" → 5-6
- "lively", "fun", "upbeat" → 6-7
- "energetic", "pumping", "party" → 8-9

## Genre Intelligence — How to Fill genreHints
When calling generate_recommendations, you MUST include genreHints — 4-8 specific genre/style keywords based on your expert synthesis of the full conversation + research. This is your core expertise: translating what the customer wants into concrete music direction.

ANTI-PATTERNS (never do this — these are lazy cliches):
- Sophisticated → jazz (could be deep house, neo-soul, bossa nova, lounge — depends entirely on the venue)
- Bar → rock (depends on the bar concept)
- Hotel → classical (only for traditional grand lobbies)
- Trendy → indie (indie is just one flavor of trendy)

CONTEXT-DRIVEN EXAMPLES:
- Rooftop bar + DJs + sunset + upscale → ["deep house", "nu-disco", "lounge", "electronic", "cocktail", "balearic"]
- Jazz bar + intimate + cocktails → ["jazz", "soul", "piano", "intimate", "bar"]
- Trendy cafe + young crowd + Instagram → ["indie", "lo-fi", "acoustic", "modern", "coffee"]
- Fine dining + wine program + date night → ["jazz", "bossa", "soul", "piano", "dinner"]
- Beach club + international + daytime → ["tropical", "reggae", "balearic", "house", "beach"]
- Hotel lobby + business + international → ["piano", "ambient", "lounge", "instrumental", "elegant"]
- Gym + high energy + young crowd → ["dance", "hits", "energy", "pop", "upbeat"]

## F&B / Cuisine-Driven Genre Intelligence
When the venue involves food or drink service, the dining concept is a critical signal:
- Japanese omakase / kaiseki → ambient, minimal, zen, instrumental piano
- Italian trattoria / osteria → bossa nova, jazz, warm acoustic
- French bistro / fine dining → jazz piano, chanson, classical crossover
- Thai / Southeast Asian → world fusion, acoustic, lounge, tropical
- Wine bar / sommelier-led → jazz, classical, sophisticated lounge
- Craft beer / taproom → indie rock, alternative, upbeat, funk
- Cocktail bar / speakeasy → deep house, nu-disco, jazz lounge, soul
- Steakhouse / grill → classic rock, blues, jazz, Americana
- Sushi bar → lo-fi, ambient, minimal electronic
- Brunch spot / all-day → acoustic covers, indie folk, soft pop

For bars: the drink program is your signal. Wine = sophistication. Craft cocktails = creativity. Beer = casual energy.

Your genreHints are the STRONGEST signal to the matching algorithm — they carry more weight than vibes. Be specific: "deep house" is better than "electronic". Use terms likely to appear in playlist names/descriptions.
${productContext}

## Structured Questions (Tool: ask_structured_question)
You have a tool to present numbered options to the customer. Use it when:
- Asking about venue type (set questionIndex: 1, totalQuestions: 3)
- Asking about what music to avoid (set allowSkip: true, allowMultiple: true)
- Asking about vocal preference
- The question has KNOWN likely answers that can be listed as 4-8 options

Do NOT use it for:
- The atmosphere/experience question — this MUST be open-ended text to get the richest signal
- Simple yes/no questions (just ask in text)
- Your first greeting or warm-up message
- Follow-up questions where the user's previous answer already narrows things down

When using it, always set allowCustom to true so the customer can type something different.
NEVER use emojis in option labels or descriptions. Keep them clean text only.

IMPORTANT: When you call this tool, your text content in the SAME turn must NOT contain the question itself — the structured card IS the question. Your text should only acknowledge or comment on the customer's previous answer. For example, if the customer just described their venue's vibe and you are now asking about vocals, your text says something like "That gives me a strong picture of the atmosphere." and then the structured question card asks about vocal preference. NEVER write the question in text AND in the card — the customer would see it twice.

After the customer answers a structured question, continue the conversation naturally in text — acknowledge their choice, add a brief expert comment, then ask your next question.

## Using Venue Research (Tool: research_venue)
After learning the venue name and location, call research_venue with 3-4 search queries. ALWAYS include at least one trend-focused query such as "trending music for [venue type] ${new Date().getFullYear()}" or "[location] music scene ${new Date().getFullYear()}". This keeps your recommendations current and informed by what is working right now in the industry.

CRITICAL: When you get research results back, draw DESIGN CONCLUSIONS. Do NOT repeat facts the customer already told you.

BAD: "I can see Horizon is a 1,390 sqm rooftop bar on the 34th floor of the Hilton Pattaya with panoramic views."
GOOD: "The sunset-facing terrace and DJ program tell me we should build around upscale electronic — deep house for the golden hour, transitioning to more energetic sets as the night picks up."

Use research to conclude:
- What genre direction fits the venue concept (DJs = electronic foundation, not jazz by default)
- What the guest demographic likely is (Hilton Pattaya = international tourists + expats, 25-45)
- How unique venue features should shape the energy arc (sunset views = important opening mood; late-night DJ sets = peak energy climax)
- What the F&B concept tells you about the vibe (cocktail-forward = sophisticated, craft beer = casual)

If research returns no useful results, continue the conversation without mentioning it.

## Existing Client Lookup (Tool: lookup_existing_client)
For the SYB product only, after learning the venue name, call lookup_existing_client to check if they are an existing SYB client. Do NOT use this tool for Beat Breeze customers.
- If found as SYB client: Welcome them back warmly. You will receive their zone names — use this to ask which zones they want to work on.
- If found from previous brief: Acknowledge them as a returning client and reference their previous brief context.
- If not found: Continue as a new client. Do NOT mention the lookup or that they were not found.

## After Generating Recommendations
Present the results like a designer presenting their work:
- Briefly explain your DESIGN RATIONALE — why the schedule flows the way it does and how it matches their venue concept (2-3 sentences)
- Tell them to click "Preview on SYB" to listen to each playlist
- Ask them to select the ones they like with "Add to brief"
- Once happy, they can click "Review your music schedule" to see a summary before sending to the design team
- If they want changes, adjust and regenerate
- Do NOT re-list the playlists — the customer can already see the cards

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
      genreHints: {
        type: 'array',
        items: { type: 'string' },
        description: 'Genre/style keywords that best match the venue based on your expert analysis of the full conversation and research. Use specific terms likely to appear in playlist names/descriptions (e.g. ["deep house", "nu-disco", "cocktail", "lounge", "electronic"] for an upscale rooftop bar). These are the STRONGEST signal to the matching algorithm. Max 8 keywords.',
        maxItems: 8,
      },
      zones: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Zone name (e.g. "Lobby", "Bar", "Pool Deck")' },
            hours: { type: 'string', description: 'Operating hours for this zone (if different from main venue)' },
            energy: { type: 'number', minimum: 1, maximum: 10, description: 'Energy level for this zone' },
            vibes: { type: 'array', items: { type: 'string' }, description: 'Vibes for this zone' },
            genreHints: { type: 'array', items: { type: 'string' }, description: 'Genre hints for this zone' },
          },
          required: ['name', 'energy', 'vibes'],
        },
        description: 'Per-zone configuration for multi-zone venues. Omit for single-zone venues (uses top-level fields). Each zone gets its own playlist schedule.',
      },
      weekendMode: {
        type: 'object',
        properties: {
          energy: { type: 'number', minimum: 1, maximum: 10, description: 'Weekend energy level override' },
          vibes: { type: 'array', items: { type: 'string' }, description: 'Weekend vibe overrides' },
          genreHints: { type: 'array', items: { type: 'string' }, description: 'Weekend genre hint overrides' },
        },
        description: 'Weekend override. If provided, generates a separate weekend schedule with adjusted energy/vibes.',
      },
    },
    required: ['venueType', 'vibes', 'energy'],
  },
};

// ---------------------------------------------------------------------------
// Structured Question Tool — presented as UI questionnaire in client
// ---------------------------------------------------------------------------
const STRUCTURED_QUESTION_TOOL = {
  name: 'ask_structured_question',
  description: 'Present a structured question with numbered options to the customer. Use for questions with known likely answers (venue type, vibe, energy level, vocal preference, avoidances). Do NOT use for open-ended questions, yes/no questions, or the first greeting. Only present ONE question per call. CRITICAL: When you call this tool, your accompanying text must NOT contain the question — the card IS the question. Your text should only acknowledge or comment on the previous answer.',
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
        description: 'Up to 4 search queries to research the venue context and current music trends. Example: ["Horizon rooftop bar Hilton Pattaya", "Hilton Pattaya hotel", "Pattaya nightlife scene", "trending music rooftop bars 2026"]',
        maxItems: 4,
      },
    },
    required: ['venueName', 'searchQueries'],
  },
};

const CLIENT_LOOKUP_TOOL = {
  name: 'lookup_existing_client',
  description: 'Check if a venue is an existing Soundtrack Your Brand (SYB) client. Call this AFTER learning the venue name, alongside or before research_venue. Only available for the SYB product — skip for Beat Breeze. Returns account info and sound zone names if found.',
  input_schema: {
    type: 'object',
    properties: {
      venueName: { type: 'string', description: 'Name of the venue to look up' },
    },
    required: ['venueName'],
  },
};

const ALL_TOOLS = [RECOMMEND_TOOL, STRUCTURED_QUESTION_TOOL, RESEARCH_VENUE_TOOL, CLIENT_LOOKUP_TOOL];

// ---------------------------------------------------------------------------
// Brave Search — venue research
// ---------------------------------------------------------------------------
async function executeVenueResearch(toolInput) {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    return { success: false, summary: 'Web search is not configured (no BRAVE_SEARCH_API_KEY). Continue without research.' };
  }

  const queries = (toolInput.searchQueries || []).slice(0, 4);
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

// ---------------------------------------------------------------------------
// SYB GraphQL API — existing client lookup
// ---------------------------------------------------------------------------
const SYB_API = 'https://api.soundtrackyourbrand.com/v2';

async function sybQuery(query, variables = {}) {
  if (!process.env.SOUNDTRACK_API_TOKEN) return null;
  const res = await fetch(SYB_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${process.env.SOUNDTRACK_API_TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

async function sybSearchAccount(name) {
  const data = await sybQuery(`
    query { me { ... on User { accounts(first: 200) { edges { node { id businessName } } } }
                 ... on PublicAPIClient { accounts(first: 200) { edges { node { id businessName } } } } } }
  `);
  const accounts = data?.me?.accounts?.edges?.map(e => e.node) || [];
  return accounts.filter(a => a.businessName.toLowerCase().includes(name.toLowerCase()));
}

async function sybGetZones(accountId) {
  const data = await sybQuery(`
    query($id: ID!) { account(id: $id) { soundZones(first: 100) {
      edges { node { id name location { id name } } } } } }
  `, { id: accountId });
  return data?.account?.soundZones?.edges?.map(e => e.node) || [];
}

async function executeClientLookup(toolInput) {
  const venueName = toolInput.venueName || '';
  const result = { venueName, found: false, source: null };

  // 1. Try SYB API lookup
  if (process.env.SOUNDTRACK_API_TOKEN && venueName) {
    try {
      const matches = await sybSearchAccount(venueName);
      if (matches.length > 0) {
        const account = matches[0];
        const zones = await sybGetZones(account.id);
        result.found = true;
        result.source = 'syb';
        result.accountName = account.businessName;
        result.accountId = account.id;
        result.zones = zones.map(z => ({ name: z.name, id: z.id, location: z.location?.name || '' }));
        result.zoneCount = zones.length;
        if (matches.length > 1) {
          result.otherMatches = matches.slice(1, 4).map(m => m.businessName);
        }
      }
    } catch (err) {
      console.error('SYB lookup error:', err.message);
    }
  }

  // 2. Fall back to local venues table for previous brief history
  if (!result.found && pool) {
    try {
      const { rows } = await pool.query(
        `SELECT v.venue_name, v.venue_type, v.location, v.syb_account_id,
                b.created_at as last_brief_date, b.product
         FROM venues v LEFT JOIN briefs b ON v.latest_brief_id = b.id
         WHERE LOWER(v.venue_name) LIKE LOWER($1)
         ORDER BY v.updated_at DESC LIMIT 1`,
        [`%${venueName}%`]
      );
      if (rows.length > 0) {
        result.found = true;
        result.source = 'database';
        result.previousBrief = {
          venueName: rows[0].venue_name,
          venueType: rows[0].venue_type,
          location: rows[0].location,
          lastBriefDate: rows[0].last_brief_date,
          product: rows[0].product,
        };
      }
    } catch (err) {
      console.error('DB venue lookup error:', err.message);
    }
  }

  return result;
}

// Execute the recommendation tool server-side
function executeRecommendationTool(toolInput, product = 'syb') {
  const baseData = {
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
    genreHints: toolInput.genreHints || [],
  };

  const zones = toolInput.zones;
  const isMultiZone = Array.isArray(zones) && zones.length > 0;

  // Helper: run pipeline for a single data set
  function runPipeline(data) {
    const energy = parseInt(data.energy, 10) || 5;
    const dayparts = generateDayparts(data.hours, energy);
    const result = deterministicMatch(data, dayparts);
    const enriched = enrichRecommendations(result);
    return { dayparts, ...enriched };
  }

  if (!isMultiZone) {
    // Single-zone path (backward compatible)
    const { dayparts, ...rest } = runPipeline(baseData);
    return { dayparts, ...rest, extractedBrief: baseData, product, multiZone: false };
  }

  // Multi-zone path: run pipeline per zone
  const allDayparts = {};
  const allRecommendations = [];

  for (const zone of zones) {
    const zoneData = {
      ...baseData,
      hours: zone.hours || baseData.hours,
      energy: zone.energy || baseData.energy,
      vibes: zone.vibes || baseData.vibes,
      genreHints: zone.genreHints || baseData.genreHints,
    };

    const { dayparts, recommendations, designerNotes } = runPipeline(zoneData);
    allDayparts[zone.name] = dayparts;
    for (const rec of recommendations) {
      allRecommendations.push({ ...rec, zone: zone.name });
    }
  }

  // Weekend mode: re-run all zones with adjusted energy/vibes
  let weekendDayparts = null;
  let weekendRecommendations = null;
  if (toolInput.weekendMode) {
    const wm = toolInput.weekendMode;
    weekendDayparts = {};
    weekendRecommendations = [];
    for (const zone of zones) {
      const weekendData = {
        ...baseData,
        hours: zone.hours || baseData.hours,
        energy: wm.energy || zone.energy || baseData.energy,
        vibes: wm.vibes || zone.vibes || baseData.vibes,
        genreHints: wm.genreHints || zone.genreHints || baseData.genreHints,
      };
      const { dayparts, recommendations } = runPipeline(weekendData);
      weekendDayparts[zone.name] = dayparts;
      for (const rec of recommendations) {
        weekendRecommendations.push({ ...rec, zone: zone.name, scheduleType: 'weekend' });
      }
    }
  }

  return {
    dayparts: allDayparts,
    recommendations: allRecommendations,
    designerNotes: 'Multi-zone recommendations generated per zone.',
    extractedBrief: baseData,
    product,
    multiZone: true,
    zoneNames: zones.map(z => z.name),
    weekendDayparts,
    weekendRecommendations,
  };
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

    // Helper: execute a single tool and return its result text
    async function executeToolCall(toolBlock) {
      if (toolBlock.name === 'lookup_existing_client') {
        const lookupResult = await executeClientLookup(toolBlock.input);
        if (lookupResult.found && lookupResult.source === 'syb') {
          const zoneList = lookupResult.zones.map(z => z.name).join(', ');
          let text = `Found existing SYB client: "${lookupResult.accountName}" with ${lookupResult.zoneCount} sound zone(s): ${zoneList}. This is a returning client — welcome them back warmly. Reference their zone names when discussing music design. If they have multiple zones, ask which ones we are working on today.`;
          if (lookupResult.otherMatches) {
            text += ` (Note: other possible matches: ${lookupResult.otherMatches.join(', ')})`;
          }
          return text;
        } else if (lookupResult.found && lookupResult.source === 'database') {
          const prev = lookupResult.previousBrief;
          return `Found previous brief for "${prev.venueName}" (${prev.venueType || 'unknown type'}, ${prev.location || 'unknown location'}). Last brief: ${prev.lastBriefDate ? new Date(prev.lastBriefDate).toLocaleDateString() : 'unknown'}. This is a returning client — acknowledge them warmly but continue gathering fresh information for this brief.`;
        } else {
          return `No existing SYB account or previous brief found for "${lookupResult.venueName}". This appears to be a new client — continue normally.`;
        }
      }

      if (toolBlock.name === 'research_venue') {
        const researchResult = await executeVenueResearch(toolBlock.input);
        return researchResult.success
          ? `Research results for ${researchResult.venueName}:\n${researchResult.summary}\n\nDraw a DESIGN CONCLUSION from this research — what does it mean for their music direction? If trend data was found, use it to inform your genreHints later. Share your expert insight (1-2 sentences) that shows you understand their venue concept. Do NOT repeat facts the customer already told you. Then ask about operating hours as a standalone question.`
          : `${researchResult.summary}\nContinue the conversation — ask about operating hours next.`;
      }

      return null; // Unknown tool — should not happen
    }

    // Helper: handle a completed API response (tool use or text)
    async function handleResponse(resp, msgs) {
      if (resp.stop_reason === 'tool_use') {
        const toolUseBlocks = resp.content.filter(b => b.type === 'tool_use');
        const textBlocks = resp.content.filter(b => b.type === 'text');

        // Stream any text before the tool call
        for (const tb of textBlocks) {
          if (tb.text.trim()) {
            sendSSE('text', { content: tb.text });
          }
        }

        // Check for structured question (always handled alone — ends the response)
        const sqBlock = toolUseBlocks.find(b => b.name === 'ask_structured_question');
        if (sqBlock) {
          sendSSE('structured_question', {
            toolUseId: sqBlock.id,
            assistantContent: resp.content,
            ...sqBlock.input,
          });
          return;
        }

        // Check for generate_recommendations (always handled alone)
        const recBlock = toolUseBlocks.find(b => b.name === 'generate_recommendations');
        if (recBlock) {
          const toolResult = executeRecommendationTool(recBlock.input, product);

          sendSSE('recommendations', {
            recommendations: toolResult.recommendations,
            dayparts: toolResult.dayparts,
            designerNotes: toolResult.designerNotes,
            extractedBrief: toolResult.extractedBrief,
            multiZone: toolResult.multiZone || false,
            zoneNames: toolResult.zoneNames || [],
            weekendDayparts: toolResult.weekendDayparts || null,
            weekendRecommendations: toolResult.weekendRecommendations || null,
          });

          let playlistSummary, daypartSummary;
          if (toolResult.multiZone) {
            playlistSummary = toolResult.recommendations.map(r =>
              `- [${r.zone}] ${r.name} (${r.daypart}, ${r.matchScore}% match)`
            ).join('\n');
            daypartSummary = toolResult.zoneNames.map(z => {
              const dps = toolResult.dayparts[z] || [];
              return `${z}: ${dps.map(d => d.label).join(', ')}`;
            }).join(' | ');
          } else {
            playlistSummary = toolResult.recommendations.map(r =>
              `- ${r.name} (${r.daypart}, ${r.matchScore}% match)`
            ).join('\n');
            daypartSummary = toolResult.dayparts.map(d => d.label).join(', ');
          }

          // Build tool_results for ALL tool_use blocks (rec + any others called simultaneously)
          const toolResults = [];
          for (const block of toolUseBlocks) {
            if (block.id === recBlock.id) {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: toolResult.multiZone
                  ? `Generated ${toolResult.recommendations.length} playlist recommendations across ${toolResult.zoneNames.length} zones (${daypartSummary}):\n${playlistSummary}${toolResult.weekendRecommendations ? `\n\nAlso generated ${toolResult.weekendRecommendations.length} weekend schedule recommendations.` : ''}\n\nThe playlist cards are displayed grouped by zone. Present these results like a designer presenting their work — briefly explain your DESIGN RATIONALE for each zone and how the zones work together as a cohesive venue experience. Describe the ENERGY ARC across zones. Do NOT list the playlists (they can see the cards). Keep it to 3-4 sentences.`
                  : `Generated ${toolResult.recommendations.length} playlist recommendations across ${Array.isArray(toolResult.dayparts) ? toolResult.dayparts.length : Object.keys(toolResult.dayparts).length} dayparts (${daypartSummary}):\n${playlistSummary}\n\nThe playlist cards are displayed with preview links and "Add to brief" buttons. Present these results like a designer presenting their work — briefly explain your DESIGN RATIONALE: why this schedule flows the way it does and how it matches their venue concept. Describe the ENERGY ARC: how the music story flows from opening through peak to close. The customer should feel the journey, not just see a list. Do NOT list the playlists (they can see the cards). Keep it to 2-3 sentences.`,
              });
            } else {
              const result = await executeToolCall(block);
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result || 'Tool executed.' });
            }
          }

          const followUpMessages = [
            ...msgs,
            { role: 'assistant', content: resp.content },
            { role: 'user', content: toolResults },
          ];

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
          return;
        }

        // Handle lookup_existing_client and research_venue (may be called together)
        // Execute ALL tool calls in parallel, collect results
        const toolResults = await Promise.all(
          toolUseBlocks.map(async (block) => {
            const resultText = await executeToolCall(block);
            return {
              type: 'tool_result',
              tool_use_id: block.id,
              content: resultText || 'Tool executed.',
            };
          })
        );

        const nextMessages = [
          ...msgs,
          { role: 'assistant', content: resp.content },
          { role: 'user', content: toolResults },
        ];

        const nextResp = await anthropic.messages.create({
          model: AI_MODEL,
          max_tokens: 1500,
          system: systemPrompt,
          tools: ALL_TOOLS,
          messages: nextMessages,
        });

        await handleResponse(nextResp, nextMessages);
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

    // Store brief in PostgreSQL (non-fatal — email is the primary delivery)
    if (pool) {
      try {
        const likedIds = aiResults.likedPlaylists.map(p => p.name || p);
        const briefResult = await pool.query(
          `INSERT INTO briefs (venue_name, venue_type, location, contact_name, contact_email, product, liked_playlist_ids, conversation_summary, raw_data)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [
            data.venueName,
            data.venueType || null,
            data.location || null,
            data.contactName || null,
            data.contactEmail || null,
            data.product || 'syb',
            likedIds,
            conversationSummary || null,
            JSON.stringify({ brief, aiResults, extractedBrief }),
          ]
        );
        const briefId = briefResult.rows[0].id;

        // Upsert venue profile
        await pool.query(
          `INSERT INTO venues (venue_name, location, venue_type, latest_brief_id, updated_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (venue_name) DO UPDATE SET
             location = COALESCE(EXCLUDED.location, venues.location),
             venue_type = COALESCE(EXCLUDED.venue_type, venues.venue_type),
             latest_brief_id = EXCLUDED.latest_brief_id,
             updated_at = NOW()`,
          [data.venueName, data.location || null, data.venueType || null, briefId]
        );
      } catch (dbErr) {
        console.error('DB brief storage error (non-fatal):', dbErr.message);
      }
    }

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
