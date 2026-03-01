require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const dns = require('dns');
const crypto = require('crypto');
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

    -- New columns for scheduling pipeline (safe to re-run: IF NOT EXISTS / ADD IF NOT EXISTS)
    ALTER TABLE briefs ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'submitted';
    ALTER TABLE briefs ADD COLUMN IF NOT EXISTS schedule_data JSONB;
    ALTER TABLE briefs ADD COLUMN IF NOT EXISTS syb_account_id VARCHAR(255);
    ALTER TABLE briefs ADD COLUMN IF NOT EXISTS syb_schedule_id VARCHAR(255);
    ALTER TABLE briefs ADD COLUMN IF NOT EXISTS automation_tier INTEGER;
    ALTER TABLE venues ADD COLUMN IF NOT EXISTS auto_schedule BOOLEAN DEFAULT FALSE;
    ALTER TABLE venues ADD COLUMN IF NOT EXISTS approved_brief_count INTEGER DEFAULT 0;
    ALTER TABLE venues ADD COLUMN IF NOT EXISTS timezone VARCHAR(50) DEFAULT 'Asia/Bangkok';

    CREATE TABLE IF NOT EXISTS schedule_entries (
      id SERIAL PRIMARY KEY,
      brief_id INTEGER REFERENCES briefs(id),
      zone_id VARCHAR(255) NOT NULL,
      zone_name VARCHAR(255),
      playlist_syb_id VARCHAR(255) NOT NULL,
      playlist_name VARCHAR(255),
      start_time TIME NOT NULL,
      end_time TIME,
      days VARCHAR(20) DEFAULT 'daily',
      timezone VARCHAR(50) DEFAULT 'Asia/Bangkok',
      status VARCHAR(20) DEFAULT 'active',
      last_assigned_at TIMESTAMP,
      retry_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
    ALTER TABLE schedule_entries ADD COLUMN IF NOT EXISTS timezone VARCHAR(50) DEFAULT 'Asia/Bangkok';

    CREATE TABLE IF NOT EXISTS approval_tokens (
      id SERIAL PRIMARY KEY,
      brief_id INTEGER REFERENCES briefs(id),
      token VARCHAR(64) UNIQUE NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      used_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS follow_ups (
      id SERIAL PRIMARY KEY,
      brief_id INTEGER REFERENCES briefs(id),
      type VARCHAR(20) NOT NULL,
      scheduled_for TIMESTAMP NOT NULL,
      sent_at TIMESTAMP,
      tracking_id VARCHAR(64) UNIQUE,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS venue_zone_mappings (
      id SERIAL PRIMARY KEY,
      venue_name VARCHAR(255) NOT NULL,
      brief_zone_name VARCHAR(255) NOT NULL,
      syb_zone_id VARCHAR(255) NOT NULL,
      syb_zone_name VARCHAR(255),
      syb_account_id VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(venue_name, brief_zone_name)
    );

    CREATE INDEX IF NOT EXISTS idx_schedule_active ON schedule_entries(status, start_time) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_approval_token ON approval_tokens(token);
    CREATE INDEX IF NOT EXISTS idx_followup_pending ON follow_ups(scheduled_for) WHERE sent_at IS NULL;
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
function buildPlaylistEmailSections(aiResults, brief) {
  if (!aiResults?.likedPlaylists?.length) return '';

  const hasZones = aiResults.likedPlaylists.some(p => p.zone);

  // Build a daypart key → timeRange lookup from brief
  const timeRanges = {};
  if (brief?.dayparts) {
    for (const key of (brief.daypartOrder || Object.keys(brief.dayparts))) {
      const dp = brief.dayparts[key];
      if (dp?.timeRange) timeRanges[key] = dp.timeRange;
      if (dp?.label) timeRanges[dp.label] = dp.timeRange;
    }
  }

  const daypartCell = (p) => {
    // The daypart label often already contains the time range (e.g. "Opening (11:30 AM–3:30 PM)")
    // Only append the brief's timeRange if the label doesn't already contain a time reference
    const label = esc(p.daypart);
    const hasTimeInLabel = /\d{1,2}[:.]\d{2}/.test(p.daypart);
    if (hasTimeInLabel) return `<span style="font-weight:600;">${label}</span>`;
    const range = timeRanges[p.daypartKey] || timeRanges[p.daypart] || '';
    if (range) return `<span style="font-weight:600;">${label}</span><br><span style="color:#9ca3af;font-size:12px;">${esc(range)}</span>`;
    return `<span style="font-weight:600;">${label}</span>`;
  };

  const playlistTable = (playlists) => `<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;margin-bottom:12px;">
    <tr style="background:#f3f4f6;">
      <th style="padding:10px 12px;text-align:left;font-size:13px;color:#374151;">Playlist</th>
      <th style="padding:10px 12px;text-align:left;font-size:13px;color:#374151;">Daypart</th>
    </tr>
    ${playlists.map(p => `<tr>
      <td style="padding:10px 12px;border-bottom:1px solid #eee;">
        <a href="${esc(p.sybUrl)}" style="color:#EFA634;font-weight:600;text-decoration:none;">${esc(p.name)}</a>
        <br><span style="color:#666;font-size:12px;">${esc(p.reason)}</span>
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #eee;vertical-align:top;">${daypartCell(p)}</td>
    </tr>`).join('')}
  </table>`;

  let likedContent = '';
  if (hasZones) {
    const zoneGroups = {};
    for (const p of aiResults.likedPlaylists) {
      const z = p.zone || 'General';
      if (!zoneGroups[z]) zoneGroups[z] = [];
      zoneGroups[z].push(p);
    }
    for (const [zoneName, playlists] of Object.entries(zoneGroups)) {
      likedContent += `<p style="margin:12px 0 6px;font-weight:700;color:#EFA634;font-size:14px;">${esc(zoneName)}</p>`;
      likedContent += playlistTable(playlists);
    }
  } else {
    likedContent = playlistTable(aiResults.likedPlaylists);
  }

  return `
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

function buildEmailHtml(data, brief, aiResults, approvalUrl, sybScheduleResult = null) {
  const vibes = Array.isArray(data.vibes) ? data.vibes : [data.vibes].filter(Boolean);
  const product = data.product === 'beatbreeze' ? 'Beat Breeze' : 'Soundtrack Your Brand';
  const now = new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok', dateStyle: 'full', timeStyle: 'short' });

  const venueLabels = {
    'hotel-lobby': 'Hotel Lobby', 'restaurant': 'Restaurant', 'bar-lounge': 'Bar / Lounge',
    'spa-wellness': 'Spa / Wellness', 'fashion-retail': 'Fashion Retail', 'cafe': 'Cafe',
    'gym-fitness': 'Gym / Fitness', 'pool-beach': 'Pool / Beach Club', 'qsr': 'QSR / Fast Casual',
    'coworking': 'Co-working Space', 'other': 'Other',
  };

  const section = (title, content) => `
    <tr><td style="padding:0;">
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
        <tr><td style="padding:12px 16px;background:#1a1a2e;color:#fff;font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:1px;border-radius:6px 6px 0 0;">${title}</td></tr>
        <tr><td style="padding:16px;background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 6px 6px;">${content}</td></tr>
      </table>
    </td></tr>`;

  const row = (label, value) => value ? `<tr><td style="padding:6px 0;color:#666;width:40%;vertical-align:top;">${label}</td><td style="padding:6px 0;font-weight:500;">${value}</td></tr>` : '';

  const pill = (text) => `<span style="display:inline-block;padding:4px 12px;background:#EFA634;color:#1a1a2e;font-size:12px;font-weight:600;border-radius:12px;">${esc(text.charAt(0).toUpperCase() + text.slice(1))}</span>`;

  // --- Build venue info lines (only non-empty) ---
  const venueType = venueLabels[data.venueType] || esc(data.venueType);
  const venueMeta = [venueType, esc(data.location)].filter(Boolean).join(' &bull; ');
  const contactParts = [esc(data.contactName), esc(data.contactEmail), esc(data.contactPhone)].filter(Boolean);

  // --- Build Music Direction rows (only non-empty) ---
  const musicRows = [];
  if (vibes.length) musicRows.push(`<tr><td style="padding:8px 0;color:#666;width:35%;vertical-align:top;">Vibes</td><td style="padding:6px 0;">${vibes.map(pill).join(' &nbsp; ')}</td></tr>`);
  if (data.energy) musicRows.push(row('Energy', `${data.energy}/10`));
  if (data.vocals) musicRows.push(row('Vocals', esc(data.vocals)));
  if (data.avoidList) musicRows.push(row('Avoid / Exclude', esc(data.avoidList)));
  if (data.guestProfile) musicRows.push(row('Guest Profile', esc(data.guestProfile)));
  if (data.ageRange) musicRows.push(row('Age Range', esc(data.ageRange)));
  if (data.nationality) musicRows.push(row('Nationality', esc(data.nationality)));
  if (data.referenceVenues) musicRows.push(row('Reference Venues', esc(data.referenceVenues)));
  if (data.musicLanguages) musicRows.push(row('Languages', esc(data.musicLanguages)));
  if (data.moodChanges) musicRows.push(row('Mood Changes', esc(data.moodChanges)));
  if (data.vibeDescription) musicRows.push(row('Vibe Description', esc(data.vibeDescription)));

  // --- Genre table ---
  const daypartRow = (label, dp) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600;color:#1a1a2e;">${label}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${dp.energy}/10</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${dp.genres.join(', ')}</td>
    </tr>`;

  const genreSection = brief?.topGenres ? `
    <p style="margin:0 0 8px;"><strong>Top Genres:</strong> ${brief.topGenres.join(', ')}</p>
    <p style="margin:0 0 16px;"><strong>BPM:</strong> ${brief.bpmRanges.join(', ')}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;">
      <tr style="background:#f3f4f6;">
        <th style="padding:10px 12px;text-align:left;font-size:13px;color:#374151;">Daypart</th>
        <th style="padding:10px 12px;text-align:left;font-size:13px;color:#374151;">Energy</th>
        <th style="padding:10px 12px;text-align:left;font-size:13px;color:#374151;">Genres</th>
      </tr>
      ${(brief.daypartOrder || Object.keys(brief.dayparts)).map(key => {
        const dp = brief.dayparts[key];
        return daypartRow(dp.label || key.charAt(0).toUpperCase() + key.slice(1), dp);
      }).join('')}
    </table>` : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

  <!-- 1. Header -->
  <tr><td style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);padding:32px 24px;text-align:center;border-radius:12px 12px 0 0;">
    <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;">Music Atmosphere Brief</h1>
    <p style="margin:8px 0 0;color:#a5b4fc;font-size:13px;">${product} &bull; ${now}</p>
  </td></tr>

  <tr><td style="padding:24px 16px;background:#f9fafb;">
  <table width="100%" cellpadding="0" cellspacing="0">

  <!-- 2. Venue Overview + Approve CTA -->
  <tr><td style="padding:0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr><td style="padding:12px 16px;background:#1a1a2e;color:#fff;font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:1px;border-radius:6px 6px 0 0;">Venue Overview</td></tr>
      <tr><td style="padding:20px 16px;background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 6px 6px;">
        <h2 style="margin:0 0 4px;color:#1a1a2e;font-size:20px;">${esc(data.venueName)}</h2>
        ${venueMeta ? `<p style="margin:0 0 12px;color:#666;font-size:14px;">${venueMeta}</p>` : ''}
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
          ${row('Operating Hours', esc(data.hours))}
          ${row('Zones', esc(data.zones))}
          ${contactParts.length ? `<tr><td style="padding:6px 0;color:#666;width:40%;vertical-align:top;">Contact</td><td style="padding:6px 0;font-weight:500;">${contactParts.join(' &bull; ')}</td></tr>` : ''}
        </table>
        ${sybScheduleResult ? `
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0;">
          <tr><td style="padding:8px 12px;background:#0d3320;border:1px solid #166534;border-radius:6px;">
            <p style="margin:0;color:#4ade80;font-size:13px;font-weight:600;">Schedule Pre-Built on SYB Account</p>
            <p style="margin:4px 0 0;color:#86efac;font-size:12px;">"${esc(sybScheduleResult.scheduleName)}" &mdash; ${sybScheduleResult.slotCount} time slots created. Map zones and click Activate.</p>
          </td></tr>
        </table>` : ''}
        ${approvalUrl ? `
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr><td align="center" style="padding:8px 0 4px;">
            <a href="${esc(approvalUrl)}" style="display:inline-block;padding:14px 32px;background:#EFA634;color:#1a1a2e;font-weight:700;font-size:15px;text-decoration:none;border-radius:8px;">${sybScheduleResult ? 'Activate Schedule' : 'Approve &amp; Schedule'}</a>
          </td></tr>
          <tr><td align="center"><p style="margin:4px 0 0;color:#9ca3af;font-size:12px;">${sybScheduleResult ? 'Map SYB zones and activate the pre-built schedule.' : 'Review schedule, map SYB zones, and activate.'} Link expires in 7 days.</p></td></tr>
        </table>` : ''}
      </td></tr>
    </table>
  </td></tr>

  <!-- 3. Conversation Summary -->
  ${data._conversationSummary ? `
  <tr><td style="padding:0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr><td style="padding:12px 16px;background:#1a1a2e;color:#fff;font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:1px;border-radius:6px 6px 0 0;">Consultation Summary</td></tr>
      <tr><td style="padding:16px;background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 6px 6px;">
        <div style="border-left:4px solid #EFA634;padding:12px 16px;background:#fffbf0;border-radius:0 4px 4px 0;">
          <p style="margin:0;color:#374151;line-height:1.7;font-size:14px;">${esc(data._conversationSummary)}</p>
        </div>
      </td></tr>
    </table>
  </td></tr>` : ''}

  <!-- 4. Selected Playlists -->
  ${buildPlaylistEmailSections(aiResults, brief)}

  <!-- 5. Music Direction -->
  ${musicRows.length || genreSection ? section('Music Direction', `
    ${musicRows.length ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:${genreSection ? '20px' : '0'};">${musicRows.join('')}</table>` : ''}
    ${genreSection}
  `) : ''}

  <!-- 6. Beat Breeze (conditional) -->
  ${data.product === 'beatbreeze' && (data.aiInterest || data.instruments || data.brandStory) ? section('Beat Breeze Details', `
    <table width="100%" cellpadding="0" cellspacing="0">
      ${row('AI Music Interest', esc(data.aiInterest))}
      ${row('Preferred Instruments', esc(data.instruments))}
      ${row('Brand Story', esc(data.brandStory))}
    </table>
  `) : ''}

  </table>
  </td></tr>

  <!-- 7. Footer -->
  <tr><td style="padding:20px 24px;text-align:center;background:#1a1a2e;border-radius:0 0 12px 12px;">
    <p style="margin:0;color:#a5b4fc;font-size:12px;">BMAsia Group</p>
    ${approvalUrl ? `<p style="margin:8px 0 0;"><a href="${esc(approvalUrl)}" style="color:#EFA634;font-size:12px;text-decoration:none;">Approve &amp; Schedule &rarr;</a></p>` : ''}
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
4b. For SYB product only: call lookup_existing_client with the venue name. You can call this alongside research_venue. The tool result will tell you how to handle the match:
   - Single match: welcome them back, reference their zones, ask which zone we are designing for. The tool result includes a sybAccountId — remember it for generate_recommendations.
   - Multiple matches (2-5): use ask_structured_question to let the customer choose their account. Once confirmed, use that sybAccountId.
   - Too many matches (6+): ask the customer to check their Soundtrack app for the exact name.
   - No match: continue silently as a new client — do NOT mention the lookup.

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
   - IMPORTANT: If you have a confirmed sybAccountId from lookup_existing_client, include it in the generate_recommendations call along with sybMatchCount and zoneName. This enables automatic schedule creation on their SYB account.
   - When the customer confirms their account from a multi-match lookup, double-check that you use the exact sybAccountId from the ACCOUNT ID MAPPING provided in the tool result. Do NOT guess or approximate the ID.

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
      sybAccountId: { type: 'string', description: 'SYB account ID from lookup_existing_client (if confirmed). Pass this through so the schedule can be auto-created on the client account.' },
      sybMatchCount: { type: 'number', description: 'Number of SYB account matches from lookup (1 = auto-confirmed, 2-5 = customer chose, 0 = new client).' },
      zoneName: { type: 'string', description: 'The specific zone the customer confirmed they want music designed for (e.g. "Lobby", "Pool Deck"). From the zones listed in lookup_existing_client result.' },
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

// SYB account cache — paginate through all 900+ accounts, refresh every 30 min
let sybAccountCache = { accounts: [], lastRefresh: 0 };
const SYB_CACHE_TTL = 30 * 60 * 1000;

async function refreshSybAccountCache() {
  try {
    let all = [];
    let cursor = null;
    let hasMore = true;
    while (hasMore) {
      const afterClause = cursor ? `, after: "${cursor}"` : '';
      const data = await sybQuery(`query { me { ... on PublicAPIClient {
        accounts(first: 200${afterClause}) {
          edges { node { id businessName } cursor }
          pageInfo { hasNextPage endCursor }
        }
      } } }`);
      const edges = data?.me?.accounts?.edges || [];
      all = all.concat(edges.map(e => e.node));
      hasMore = data?.me?.accounts?.pageInfo?.hasNextPage || false;
      cursor = data?.me?.accounts?.pageInfo?.endCursor || null;
      if (edges.length === 0) break;
    }
    sybAccountCache = { accounts: all, lastRefresh: Date.now() };
    console.log(`[SYB] Cached ${all.length} accounts`);
  } catch (err) {
    console.error('[SYB] Account cache refresh failed:', err.message);
  }
}

async function sybSearchAccountCached(name) {
  if (Date.now() - sybAccountCache.lastRefresh > SYB_CACHE_TTL || sybAccountCache.accounts.length === 0) {
    await refreshSybAccountCache();
  }
  const q = name.toLowerCase();
  return sybAccountCache.accounts
    .filter(a => a.businessName.toLowerCase().includes(q))
    .sort((a, b) => {
      const aExact = a.businessName.toLowerCase() === q ? 0 : 1;
      const bExact = b.businessName.toLowerCase() === q ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      const aPrefix = a.businessName.toLowerCase().startsWith(q) ? 0 : 1;
      const bPrefix = b.businessName.toLowerCase().startsWith(q) ? 0 : 1;
      return aPrefix - bPrefix;
    });
}

async function executeClientLookup(toolInput) {
  const venueName = toolInput.venueName || '';
  const result = { venueName, found: false, source: null };

  // 1. Try SYB API lookup
  if (process.env.SOUNDTRACK_API_TOKEN && venueName) {
    try {
      const matches = await sybSearchAccountCached(venueName);
      if (matches.length > 0) {
        const account = matches[0];
        const zones = await sybGetZones(account.id);
        result.found = true;
        result.source = 'syb';
        result.accountName = account.businessName;
        result.accountId = account.id;
        result.matchCount = matches.length;
        result.zones = zones.map(z => ({ name: z.name, id: z.id, location: z.location?.name || '' }));
        result.zoneCount = zones.length;

        // For multi-match (2-5): include top matches with zones for AI disambiguation
        if (matches.length > 1 && matches.length <= 5) {
          result.accountOptions = [];
          for (const acc of matches.slice(0, 5)) {
            const accZones = await sybGetZones(acc.id);
            result.accountOptions.push({
              accountId: acc.id,
              accountName: acc.businessName,
              zones: accZones.map(z => z.name),
            });
          }
        } else if (matches.length > 1) {
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
    sybAccountId: toolInput.sybAccountId || null,
    sybMatchCount: toolInput.sybMatchCount || 0,
    zoneName: toolInput.zoneName || null,
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

// Retry wrapper for Anthropic API calls (handles 529 overloaded errors)
async function anthropicRetry(fn, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err.status === 529 && attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 8000); // 1s, 2s, 4s, 8s
        console.log(`[Retry] Anthropic 529 overloaded, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

async function summarizeConversation(transcript) {
  if (!anthropic || !transcript) return transcript;
  try {
    const result = await anthropicRetry(() => anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: `You are summarizing a customer consultation for a music design team.
Write a concise 3-5 sentence summary capturing:
- Venue concept and identity (type, location, positioning)
- Target audience and atmosphere goals
- Key music requirements (genres, energy, vocals, things to avoid)
- Any notable decisions (weekend vs weekday differences, specific creative direction)
Write in third person, professional tone. No bullet points — flowing sentences. No markdown formatting, no bold, no headers.`,
      messages: [{ role: 'user', content: transcript }]
    }));
    return result.content[0].text.replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1').replace(/^#+\s*/gm, '').trim();
  } catch (err) {
    console.log('[Submit] Conversation summary generation failed, using raw transcript:', err.message);
    return transcript;
  }
}

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
    const response = await anthropicRetry(() => anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 1500,
      system: systemPrompt,
      tools: ALL_TOOLS,
      messages,
    }));

    // Helper: execute a single tool and return its result text
    async function executeToolCall(toolBlock) {
      if (toolBlock.name === 'lookup_existing_client') {
        const lookupResult = await executeClientLookup(toolBlock.input);
        if (lookupResult.found && lookupResult.source === 'syb') {
          const zoneList = lookupResult.zones.map(z => z.name).join(', ');
          const matchCount = lookupResult.matchCount || 1;

          if (matchCount === 1) {
            // Single match — high confidence
            return `Found existing SYB client: "${lookupResult.accountName}" with ${lookupResult.zoneCount} sound zone(s): ${zoneList}. This is a returning client — welcome them back warmly. Reference their zone names when discussing music design. If they have multiple zones, ask which ones we are working on today. Include sybAccountId: '${lookupResult.accountId}' and sybMatchCount: 1 in your extractedBrief.`;
          } else if (matchCount <= 5 && lookupResult.accountOptions) {
            // Multi-match — need disambiguation
            const optionsList = lookupResult.accountOptions.map((opt, i) =>
              `${i + 1}) ${opt.accountName} (zones: ${opt.zones.length > 0 ? opt.zones.join(', ') : 'none'})`
            ).join('\n');
            return `Multiple SYB accounts matched (${matchCount}). Use ask_structured_question to let the customer choose their account:\n${optionsList}\n\nFormat the question naturally: "I found a few accounts that could be yours on Soundtrack. Which one is yours?" with each account as an option showing name and zone names.\n\nACCOUNT ID MAPPING (use the ID of whichever account the customer selects):\n${lookupResult.accountOptions.map(o => `- "${o.accountName}" → sybAccountId: "${o.accountId}"`).join('\n')}\n\nAfter the customer selects, include the corresponding sybAccountId in your extractedBrief when calling generate_recommendations. This is critical — the wrong ID would create a schedule on the wrong account.`;
          } else {
            // Too many matches
            return `Found ${matchCount} SYB accounts matching "${lookupResult.venueName}" — too many to list. Ask the customer to check their Soundtrack app — the account name appears at the top of the sidebar — and tell you the exact name. Then call lookup_existing_client again with the exact name. Do NOT include sybAccountId in extractedBrief until confirmed.`;
          }
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

        const nextResp = await anthropicRetry(() => anthropic.messages.create({
          model: AI_MODEL,
          max_tokens: 1500,
          system: systemPrompt,
          tools: ALL_TOOLS,
          messages: nextMessages,
        }));

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
      const toolResponse = await anthropicRetry(() => anthropic.messages.create({
        model: AI_MODEL,
        max_tokens: 1500,
        system: systemPrompt,
        tools: ALL_TOOLS,
        messages,
      }));

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
        const response = await anthropicRetry(() => anthropic.messages.create({
          model: AI_MODEL,
          max_tokens: 1500,
          system: buildSystemPrompt(dayparts),
          messages: [{ role: 'user', content: buildUserMessage(data) }],
        }));
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

    // Generate concise AI summary for email (raw transcript still stored in DB)
    if (conversationSummary) {
      data._conversationSummary = await summarizeConversation(conversationSummary);
    }

    // Store brief in PostgreSQL FIRST (need brief ID for approval token)
    let briefId = null;
    let approvalUrl = null;
    const scheduleData = {
      dayparts: brief.dayparts,
      daypartOrder: brief.daypartOrder || Object.keys(brief.dayparts),
      likedPlaylists: aiResults.likedPlaylists || [],
      multiZone: data.multiZone || false,
      zoneNames: data.zoneNames || [],
      weekendDayparts: data.weekendDayparts || null,
      weekendRecommendations: data.weekendRecommendations || null,
      weekendLikedPlaylists: data.weekendLikedPlaylists || [],
    };

    if (pool) {
      try {
        const likedIds = aiResults.likedPlaylists.map(p => p.name || p);
        const briefResult = await pool.query(
          `INSERT INTO briefs (venue_name, venue_type, location, contact_name, contact_email, product, liked_playlist_ids, conversation_summary, raw_data, schedule_data)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
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
            JSON.stringify(scheduleData),
          ]
        );
        briefId = briefResult.rows[0].id;

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

        // Scheduling pipeline (SYB product only)
        if (data.product !== 'beatbreeze' && briefId) {
          // Check if venue qualifies for auto-schedule
          const { rows: venueRows } = await pool.query(
            'SELECT auto_schedule, approved_brief_count, timezone FROM venues WHERE venue_name = $1',
            [data.venueName]
          );
          const venueRow = venueRows[0];
          const canAutoSchedule = venueRow?.auto_schedule && (venueRow?.approved_brief_count || 0) >= 2;

          if (canAutoSchedule) {
            // Auto-schedule: create entries directly using saved zone mappings
            const { rows: mappings } = await pool.query(
              'SELECT * FROM venue_zone_mappings WHERE venue_name = $1',
              [data.venueName]
            );

            if (mappings.length > 0) {
              let entriesCreated = 0;
              const allPlaylists = [...(scheduleData.likedPlaylists || []), ...(scheduleData.weekendLikedPlaylists || [])];
              for (const playlist of allPlaylists) {
                const zoneName = playlist.zone || 'Main';
                const mapping = mappings.find(m => m.brief_zone_name === zoneName);
                if (!mapping) continue;

                const dpKey = playlist.daypart;
                const dp = scheduleData.dayparts?.[dpKey];
                const timeRange = dp?.timeRange || playlist.timeRange || '';
                const startTime = parseStartTime(timeRange);
                const endTime = parseEndTime(timeRange);
                if (!startTime) continue;

                const sybId = playlist.sybId || findPlaylistSybId(playlist.name || playlist.playlistId);
                if (!sybId) continue;

                const days = playlist.scheduleType === 'weekend' ? 'weekend' : 'daily';
                const tz = venueRow?.timezone || 'Asia/Bangkok';
                await pool.query(
                  `INSERT INTO schedule_entries (brief_id, zone_id, zone_name, playlist_syb_id, playlist_name, start_time, end_time, days, timezone)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                  [briefId, mapping.syb_zone_id, zoneName, sybId, playlist.name, startTime, endTime, days, tz]
                );
                entriesCreated++;
              }

              if (entriesCreated > 0) {
                await pool.query('UPDATE briefs SET status = $1 WHERE id = $2', ['approved', briefId]);
                await pool.query(
                  'UPDATE venues SET approved_brief_count = approved_brief_count + 1, updated_at = NOW() WHERE venue_name = $1',
                  [data.venueName]
                );
                console.log(`[AutoSchedule] Created ${entriesCreated} entries for returning client "${data.venueName}"`);
              }
            }
          }

          // Always generate approval token (even for auto-schedule, as a fallback/view link)
          const token = crypto.randomBytes(32).toString('hex');
          await pool.query(
            `INSERT INTO approval_tokens (brief_id, token, expires_at)
             VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
            [briefId, token]
          );
          const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
          approvalUrl = `${baseUrl}/approve/${token}`;
          console.log(`[Submit] Brief #${briefId} stored for "${data.venueName}" — approval: ${approvalUrl}`);

          // Create follow-up entries
          const trackingId7 = crypto.randomBytes(32).toString('hex');
          const trackingId30 = crypto.randomBytes(32).toString('hex');
          await pool.query(
            `INSERT INTO follow_ups (brief_id, type, scheduled_for, tracking_id) VALUES
             ($1, '7day', NOW() + INTERVAL '7 days', $2),
             ($1, '30day', NOW() + INTERVAL '30 days', $3)`,
            [briefId, trackingId7, trackingId30]
          );
        }
      } catch (dbErr) {
        console.error('DB brief storage error (non-fatal):', dbErr.message);
      }
    }

    // Native SYB schedule creation (Phase 1: create + library, design team activates)
    let sybScheduleResult = null;
    if (data.product !== 'beatbreeze' && data.sybAccountId && briefId) {
      // Validate sybAccountId exists in our account cache
      if (sybAccountCache.accounts.length === 0) {
        await refreshSybAccountCache();
      }
      const accountValid = sybAccountCache.accounts.some(a => a.id === data.sybAccountId);
      if (!accountValid) {
        console.log(`[Submit] sybAccountId "${data.sybAccountId}" not found in cache — skipping schedule creation`);
        data.sybAccountId = null;
      }
    }
    if (data.product !== 'beatbreeze' && data.sybAccountId && briefId) {
      try {
        const scheduleInput = buildSybSchedule({
          venueName: data.venueName,
          zoneName: extractedBrief?.zoneName || 'Main',
          accountId: data.sybAccountId,
          briefId,
          likedPlaylists: [
            ...(aiResults.likedPlaylists || []),
            ...(data.weekendLikedPlaylists || []),
          ],
          dayparts: brief.dayparts,
        });

        if (scheduleInput && scheduleInput.slots.length > 0) {
          // Step 1: Create schedule
          const createResult = await sybQuery(`
            mutation($input: CreateScheduleInput!) {
              createSchedule(input: $input) { id name slots { id } }
            }
          `, { input: scheduleInput });

          const scheduleId = createResult?.createSchedule?.id;
          if (scheduleId) {
            // Step 2: Add to music library (makes it visible in SYB app)
            try {
              await sybQuery(`
                mutation($input: AddToMusicLibraryInput!) {
                  addToMusicLibrary(input: $input) { musicLibrary { schedules(first: 1) { edges { node { id } } } } }
                }
              `, { input: { parent: data.sybAccountId, source: scheduleId } });
            } catch (libErr) {
              console.log('[Submit] addToMusicLibrary failed (non-critical):', libErr.message);
            }

            sybScheduleResult = {
              scheduleId,
              scheduleName: scheduleInput.name,
              slotCount: scheduleInput.slots.length,
            };

            // Store schedule ID and account ID on the brief
            await pool.query(
              'UPDATE briefs SET syb_account_id = $1, syb_schedule_id = $2, automation_tier = 1 WHERE id = $3',
              [data.sybAccountId, scheduleId, briefId]
            );

            console.log(`[Submit] SYB schedule created: ${scheduleInput.name} (${scheduleInput.slots.length} slots)`);
          }
        }
      } catch (err) {
        console.log('[Submit] SYB schedule creation failed (falling back to manual):', err.message);
      }
    }

    const html = buildEmailHtml(data, brief, aiResults, approvalUrl, sybScheduleResult);

    const product = data.product === 'beatbreeze' ? 'Beat Breeze' : 'SYB';
    const subject = sybScheduleResult
      ? `[Schedule Ready] Music Brief: ${data.venueName} (SYB)`
      : `Music Brief: ${data.venueName} (${product})`;

    await transporter.sendMail({
      from: `"BMAsia Music Brief" <${GMAIL_USER}>`,
      to: RECIPIENT_EMAIL,
      subject,
      html,
    });
    console.log(`[Submit] Email sent for brief #${briefId} "${data.venueName}" to ${RECIPIENT_EMAIL}`);

    res.json({
      success: true,
      briefId,
      scheduleCreated: !!sybScheduleResult,
      scheduleName: sybScheduleResult?.scheduleName || null,
    });
  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).json({ error: 'Failed to send brief. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Approval Page — GET /approve/:token
// ---------------------------------------------------------------------------
app.get('/approve/:token', async (req, res) => {
  if (!pool) return res.status(500).send('Database not configured');

  try {
    // Validate token
    const { rows: tokenRows } = await pool.query(
      `SELECT at.*, b.venue_name, b.venue_type, b.location, b.contact_name,
              b.contact_email, b.product, b.schedule_data, b.raw_data, b.status as brief_status,
              b.syb_account_id, b.syb_schedule_id, b.automation_tier
       FROM approval_tokens at
       JOIN briefs b ON at.brief_id = b.id
       WHERE at.token = $1`,
      [req.params.token]
    );

    if (tokenRows.length === 0) {
      return res.status(404).send(renderApprovalError('Invalid Link', 'This approval link is not valid.'));
    }

    const tokenData = tokenRows[0];

    if (tokenData.used_at) {
      return res.status(410).send(renderApprovalError('Already Approved', 'This brief has already been approved and scheduled.'));
    }

    if (new Date(tokenData.expires_at) < new Date()) {
      return res.status(410).send(renderApprovalError('Link Expired', 'This approval link has expired. Please request a new brief submission.'));
    }

    // Fetch SYB zones for zone mapping
    // If we have a confirmed account from the conversation, use that; otherwise search by name
    let sybZones = [];
    let sybAccountId = tokenData.syb_account_id || null;
    if (process.env.SOUNDTRACK_API_TOKEN) {
      try {
        if (sybAccountId) {
          sybZones = await sybGetZones(sybAccountId);
        } else {
          const accounts = await sybSearchAccountCached(tokenData.venue_name);
          if (accounts.length > 0) {
            sybAccountId = accounts[0].id;
            sybZones = await sybGetZones(sybAccountId);
          }
        }
      } catch (err) {
        console.error('SYB zone lookup for approval page:', err.message);
      }
    }

    // Also check for existing zone mappings
    const { rows: existingMappings } = await pool.query(
      'SELECT * FROM venue_zone_mappings WHERE venue_name = $1',
      [tokenData.venue_name]
    );

    const schedule = tokenData.schedule_data || {};
    const likedPlaylists = schedule.likedPlaylists || [];
    const daypartOrder = schedule.daypartOrder || [];
    const dayparts = schedule.dayparts || {};
    const zoneNames = schedule.zoneNames || [];
    const isMultiZone = schedule.multiZone && zoneNames.length > 0;

    res.send(renderApprovalPage({
      token: req.params.token,
      brief: tokenData,
      likedPlaylists,
      daypartOrder,
      dayparts,
      zoneNames: isMultiZone ? zoneNames : ['Main'],
      isMultiZone,
      sybZones,
      sybAccountId,
      existingMappings,
      weekendPlaylists: schedule.weekendLikedPlaylists || [],
      weekendDayparts: schedule.weekendDayparts || null,
      sybScheduleId: tokenData.syb_schedule_id || null,
    }));
  } catch (err) {
    console.error('Approval page error:', err);
    res.status(500).send(renderApprovalError('Server Error', 'Something went wrong. Please try again.'));
  }
});

// ---------------------------------------------------------------------------
// Approval Processing — POST /approve/:token
// ---------------------------------------------------------------------------
app.post('/approve/:token', express.urlencoded({ extended: true }), async (req, res) => {
  if (!pool) return res.status(500).send('Database not configured');

  try {
    // Validate token
    const { rows: tokenRows } = await pool.query(
      `SELECT at.*, b.venue_name, b.schedule_data, b.id as brief_id, b.syb_schedule_id
       FROM approval_tokens at
       JOIN briefs b ON at.brief_id = b.id
       WHERE at.token = $1 AND at.used_at IS NULL AND at.expires_at > NOW()`,
      [req.params.token]
    );

    if (tokenRows.length === 0) {
      return res.status(400).send(renderApprovalError('Invalid or Expired', 'This approval link is no longer valid.'));
    }

    const tokenData = tokenRows[0];
    const briefId = tokenData.brief_id;
    const schedule = tokenData.schedule_data || {};

    // Get venue timezone
    const { rows: venueRows } = await pool.query(
      'SELECT timezone FROM venues WHERE venue_name = $1', [tokenData.venue_name]
    );
    const venueTz = venueRows[0]?.timezone || 'Asia/Bangkok';
    const likedPlaylists = schedule.likedPlaylists || [];
    const zoneNames = schedule.multiZone && schedule.zoneNames?.length ? schedule.zoneNames : ['Main'];

    // Parse zone mappings from form
    const zoneMappings = {};
    for (const zoneName of zoneNames) {
      const sybZoneId = req.body[`zone_${zoneName}`];
      const sybZoneName = req.body[`zone_name_${zoneName}`] || '';
      if (sybZoneId) {
        zoneMappings[zoneName] = { sybZoneId, sybZoneName };
      }
    }

    if (Object.keys(zoneMappings).length === 0) {
      return res.status(400).send(renderApprovalError('No Zones Mapped', 'Please map at least one zone to a SYB sound zone.'));
    }

    // Save zone mappings
    const sybAccountId = req.body.syb_account_id || null;
    for (const [briefZoneName, mapping] of Object.entries(zoneMappings)) {
      await pool.query(
        `INSERT INTO venue_zone_mappings (venue_name, brief_zone_name, syb_zone_id, syb_zone_name, syb_account_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (venue_name, brief_zone_name) DO UPDATE SET
           syb_zone_id = EXCLUDED.syb_zone_id,
           syb_zone_name = EXCLUDED.syb_zone_name,
           syb_account_id = EXCLUDED.syb_account_id`,
        [tokenData.venue_name, briefZoneName, mapping.sybZoneId, mapping.sybZoneName, sybAccountId]
      );
    }

    // Check if this brief has a pre-built SYB schedule (Phase 1 automation)
    const sybScheduleId = tokenData.syb_schedule_id || req.body.syb_schedule_id || null;
    let entriesCreated = 0;

    if (sybScheduleId) {
      // Pre-built schedule: assign it directly to mapped zones via SYB API
      const zoneIds = Object.values(zoneMappings).map(m => m.sybZoneId);
      try {
        await sybQuery(`
          mutation($input: SoundZoneAssignSourceInput!) {
            soundZoneAssignSource(input: $input) {
              soundZones
              source { ... on Schedule { id name } }
            }
          }
        `, { input: { soundZones: zoneIds, source: sybScheduleId } });
        entriesCreated = zoneIds.length;
        console.log(`[Activate] Assigned schedule ${sybScheduleId} to ${zoneIds.length} zone(s)`);
      } catch (assignErr) {
        console.error('[Activate] soundZoneAssignSource failed:', assignErr.message);
        return res.status(500).send(renderApprovalError('Activation Failed', `Failed to assign schedule to zones: ${assignErr.message}. Please try again.`));
      }
    } else {
      // Manual path: create schedule_entries for the background worker
      for (const playlist of likedPlaylists) {
        const zoneName = playlist.zone || 'Main';
        const mapping = zoneMappings[zoneName];
        if (!mapping) continue;

        const dpKey = playlist.daypart;
        const dp = schedule.dayparts?.[dpKey];
        const timeRange = dp?.timeRange || playlist.timeRange || '';
        const startTime = parseStartTime(timeRange);
        const endTime = parseEndTime(timeRange);
        if (!startTime) continue;

        const sybId = playlist.sybId || findPlaylistSybId(playlist.name || playlist.playlistId);
        if (!sybId) continue;

        const days = playlist.scheduleType === 'weekend' ? 'weekend' : 'daily';

        await pool.query(
          `INSERT INTO schedule_entries (brief_id, zone_id, zone_name, playlist_syb_id, playlist_name, start_time, end_time, days, timezone)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [briefId, mapping.sybZoneId, zoneName, sybId, playlist.name, startTime, endTime, days, venueTz]
        );
        entriesCreated++;
      }

      // Also handle weekend playlists if present
      const weekendPlaylists = schedule.weekendLikedPlaylists || [];
      for (const playlist of weekendPlaylists) {
        const zoneName = playlist.zone || 'Main';
        const mapping = zoneMappings[zoneName];
        if (!mapping) continue;

        const dpKey = playlist.daypart;
        const dp = schedule.weekendDayparts?.[dpKey] || schedule.dayparts?.[dpKey];
        const timeRange = dp?.timeRange || playlist.timeRange || '';
        const startTime = parseStartTime(timeRange);
        const endTime = parseEndTime(timeRange);
        if (!startTime) continue;

        const sybId = playlist.sybId || findPlaylistSybId(playlist.name || playlist.playlistId);
        if (!sybId) continue;

        await pool.query(
          `INSERT INTO schedule_entries (brief_id, zone_id, zone_name, playlist_syb_id, playlist_name, start_time, end_time, days, timezone)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'weekend', $8)`,
          [briefId, mapping.sybZoneId, zoneName, sybId, playlist.name, startTime, endTime, venueTz]
        );
        entriesCreated++;
      }
    }

    // Mark token as used
    await pool.query('UPDATE approval_tokens SET used_at = NOW() WHERE id = $1', [tokenData.id]);

    // Update brief status
    await pool.query('UPDATE briefs SET status = $1 WHERE id = $2', [sybScheduleId ? 'scheduled' : 'approved', briefId]);

    // Increment venue approved count
    await pool.query(
      `UPDATE venues SET approved_brief_count = approved_brief_count + 1, updated_at = NOW()
       WHERE venue_name = $1`,
      [tokenData.venue_name]
    );

    const successMsg = sybScheduleId
      ? `Schedule activated and assigned to ${entriesCreated} zone(s). The player will start following the schedule immediately.`
      : `${entriesCreated} schedule ${entriesCreated === 1 ? 'entry' : 'entries'} created. The background worker will assign playlists at the scheduled times.`;
    res.send(renderApprovalSuccess(tokenData.venue_name, entriesCreated, sybScheduleId ? 'activated' : 'approved'));
  } catch (err) {
    console.error('Approval processing error:', err);
    res.status(500).send(renderApprovalError('Server Error', 'Failed to process approval. Please try again.'));
  }
});

// ---------------------------------------------------------------------------
// Helpers: time parsing, playlist lookup, approval page rendering
// ---------------------------------------------------------------------------

function parseStartTime(timeRange) {
  // Parse "9:00 AM - 12:00 PM" or "09:00 - 12:00" or "9am - 12pm" format
  if (!timeRange) return null;
  const match = timeRange.match(/(\d{1,2}):?(\d{2})?\s*(AM|PM|am|pm)?/);
  if (!match) return null;
  let hours = parseInt(match[1], 10);
  const minutes = match[2] || '00';
  const ampm = (match[3] || '').toUpperCase();
  if (ampm === 'PM' && hours < 12) hours += 12;
  if (ampm === 'AM' && hours === 12) hours = 0;
  return `${String(hours).padStart(2, '0')}:${minutes}`;
}

function parseEndTime(timeRange) {
  if (!timeRange) return null;
  // Match the second time in the range (after dash/hyphen)
  const parts = timeRange.split(/[-–]/);
  if (parts.length < 2) return null;
  return parseStartTime(parts[1].trim());
}

function findPlaylistSybId(playlistName) {
  if (!playlistName) return null;
  const match = PLAYLIST_CATALOG.find(p =>
    p.name.toLowerCase() === playlistName.toLowerCase()
  );
  return match?.sybId || null;
}

// ---------------------------------------------------------------------------
// Native SYB schedule builder (Phase 1)
// ---------------------------------------------------------------------------

function parseStartTimeForSyb(timeRange) {
  // "9:00 AM - 12:00 PM" → "090000"
  const match = timeRange.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return null;
  let h = parseInt(match[1]);
  const m = match[2];
  const ampm = match[3].toUpperCase();
  if (ampm === 'PM' && h < 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return String(h).padStart(2, '0') + m + '00';
}

function parseTimeToMinutes(timeStr) {
  const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return null;
  let h = parseInt(match[1]);
  const m = parseInt(match[2]);
  const ampm = match[3].toUpperCase();
  if (ampm === 'PM' && h < 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return h * 60 + m;
}

function parseDurationMs(timeRange) {
  // "9:00 AM - 12:00 PM" → 10800000 (3 hours in ms)
  const parts = timeRange.split('-').map(s => s.trim());
  if (parts.length !== 2) return null;
  const startMin = parseTimeToMinutes(parts[0]);
  const endMin = parseTimeToMinutes(parts[1]);
  if (startMin === null || endMin === null) return null;
  let diff = endMin - startMin;
  if (diff <= 0) diff += 24 * 60; // crosses midnight
  return diff * 60 * 1000;
}

function buildSybSchedule({ venueName, zoneName, accountId, briefId, likedPlaylists, dayparts }) {
  const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
  const slots = [];
  const daypartOrder = dayparts ? Object.keys(dayparts) : [];

  for (const playlist of likedPlaylists) {
    const sybId = playlist.sybId || findPlaylistSybId(playlist.name);
    if (!sybId) continue;

    // Find matching daypart for time range
    const dpKey = playlist.daypart;
    const dp = dpKey && dayparts ? dayparts[dpKey] : null;
    const timeRange = dp?.timeRange || playlist.timeRange;
    if (!timeRange) continue;

    const startTime = parseStartTimeForSyb(timeRange);
    const durationMs = parseDurationMs(timeRange);
    if (!startTime || !durationMs) continue;

    const days = playlist.scheduleType === 'weekend' ? ['SA', 'SU'] :
                 playlist.scheduleType === 'weekday' ? ['MO', 'TU', 'WE', 'TH', 'FR'] : DAYS;

    for (const day of days) {
      slots.push({
        rrule: `FREQ=WEEKLY;BYDAY=${day}`,
        start: startTime,
        duration: durationMs,
        playlistIds: [sybId],
      });
    }
  }

  if (slots.length === 0) return null;

  const scheduleName = `${venueName} ${zoneName || ''} — by BMAsia`.replace(/\s+/g, ' ').trim();

  return {
    ownerId: accountId,
    name: scheduleName,
    presentAs: 'daily',
    description: `Music design by BMAsia (Brief #${briefId})`,
    slots,
  };
}

function renderApprovalError(title, message) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} - BMAsia Music Brief</title>
<style>
  body{margin:0;padding:40px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f0f23;color:#e5e7eb;display:flex;justify-content:center;align-items:center;min-height:100vh;}
  .card{max-width:480px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:48px 32px;text-align:center;}
  h1{margin:0 0 16px;color:#EFA634;font-size:24px;}
  p{margin:0;color:#9ca3af;font-size:15px;line-height:1.6;}
</style></head><body>
<div class="card"><h1>${esc(title)}</h1><p>${esc(message)}</p></div>
</body></html>`;
}

function renderApprovalSuccess(venueName, entriesCreated, mode = 'approved') {
  const isActivated = mode === 'activated';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Schedule ${isActivated ? 'Activated' : 'Approved'} - BMAsia Music Brief</title>
<style>
  body{margin:0;padding:40px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f0f23;color:#e5e7eb;display:flex;justify-content:center;align-items:center;min-height:100vh;}
  .card{max-width:480px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:48px 32px;text-align:center;}
  h1{margin:0 0 16px;color:#059669;font-size:24px;}
  .count{font-size:48px;font-weight:700;color:#EFA634;margin:16px 0;}
  p{margin:0 0 8px;color:#9ca3af;font-size:15px;line-height:1.6;}
  .venue{color:#e5e7eb;font-weight:600;}
</style></head><body>
<div class="card">
  <h1>Schedule ${isActivated ? 'Activated' : 'Approved'}</h1>
  <p class="venue">${esc(venueName)}</p>
  <div class="count">${entriesCreated}</div>
  <p>${isActivated ? `zone${entriesCreated === 1 ? '' : 's'} now playing the schedule` : `playlist schedule ${entriesCreated === 1 ? 'entry' : 'entries'} created`}</p>
  <p style="margin-top:24px;color:#6b7280;font-size:13px;">${isActivated ? 'The SYB player will follow the schedule automatically. No further action needed.' : 'The background worker will assign playlists to SYB zones at the scheduled times.'}</p>
</div>
</body></html>`;
}

function renderApprovalPage({ token, brief, likedPlaylists, daypartOrder, dayparts, zoneNames, isMultiZone, sybZones, sybAccountId, existingMappings, weekendPlaylists, weekendDayparts, sybScheduleId }) {
  const existingMap = {};
  for (const m of existingMappings) {
    existingMap[m.brief_zone_name] = m;
  }

  // Build zone mapping section
  let zoneMappingHtml = '';
  for (const zoneName of zoneNames) {
    const existing = existingMap[zoneName];
    const preselected = existing?.syb_zone_id || '';

    let optionsHtml = '<option value="">-- Select SYB Zone --</option>';
    for (const z of sybZones) {
      const selected = z.id === preselected ? ' selected' : '';
      const loc = z.location?.name ? ` (${esc(z.location.name)})` : '';
      optionsHtml += `<option value="${esc(z.id)}"${selected}>${esc(z.name)}${loc}</option>`;
    }
    // Manual input option
    optionsHtml += '<option value="__manual__">Enter zone ID manually...</option>';

    zoneMappingHtml += `
      <div class="zone-row">
        <label>${esc(zoneName)}</label>
        <select name="zone_${esc(zoneName)}" class="zone-select" onchange="toggleManual(this, '${esc(zoneName)}')">
          ${optionsHtml}
        </select>
        <input type="hidden" name="zone_name_${esc(zoneName)}" value="${esc(sybZones.find(z => z.id === preselected)?.name || '')}">
        <input type="text" class="manual-input" id="manual_${esc(zoneName)}" placeholder="Paste SYB zone ID" style="display:none;">
      </div>`;
  }

  // Build schedule preview
  let scheduleHtml = '';
  // Group liked playlists by zone then daypart
  const playlistsByZone = {};
  for (const p of likedPlaylists) {
    const z = p.zone || 'Main';
    if (!playlistsByZone[z]) playlistsByZone[z] = {};
    const dp = p.daypart || 'general';
    if (!playlistsByZone[z][dp]) playlistsByZone[z][dp] = [];
    playlistsByZone[z][dp].push(p);
  }

  for (const zoneName of zoneNames) {
    const zonePlaylists = playlistsByZone[zoneName] || {};
    if (isMultiZone) {
      scheduleHtml += `<div class="zone-header">${esc(zoneName)}</div>`;
    }
    for (const dpKey of daypartOrder) {
      const dp = dayparts[dpKey];
      const pls = zonePlaylists[dpKey] || [];
      if (pls.length === 0) continue;
      scheduleHtml += `<div class="dp-header">${esc(dp?.label || dpKey)} ${dp?.timeRange ? `<span class="dp-time">${esc(dp.timeRange)}</span>` : ''}</div>`;
      for (const p of pls) {
        scheduleHtml += `<div class="playlist-row">${esc(p.name)}${p.matchScore != null ? ` <span class="match">${p.matchScore}%</span>` : ''}</div>`;
      }
    }
  }

  // Weekend playlists section
  let weekendHtml = '';
  if (weekendPlaylists.length > 0) {
    weekendHtml = '<div class="section-title" style="margin-top:24px;">Weekend Schedule</div>';
    const wpByZone = {};
    for (const p of weekendPlaylists) {
      const z = p.zone || 'Main';
      if (!wpByZone[z]) wpByZone[z] = {};
      const dp = p.daypart || 'general';
      if (!wpByZone[z][dp]) wpByZone[z][dp] = [];
      wpByZone[z][dp].push(p);
    }
    for (const zoneName of zoneNames) {
      const zonePls = wpByZone[zoneName] || {};
      if (isMultiZone) weekendHtml += `<div class="zone-header">${esc(zoneName)}</div>`;
      const wdOrder = weekendDayparts ? Object.keys(weekendDayparts) : daypartOrder;
      for (const dpKey of wdOrder) {
        const dp = weekendDayparts?.[dpKey] || dayparts[dpKey];
        const pls = zonePls[dpKey] || [];
        if (pls.length === 0) continue;
        weekendHtml += `<div class="dp-header">${esc(dp?.label || dpKey)} ${dp?.timeRange ? `<span class="dp-time">${esc(dp.timeRange)}</span>` : ''}</div>`;
        for (const p of pls) {
          weekendHtml += `<div class="playlist-row">${esc(p.name)}${p.matchScore != null ? ` <span class="match">${p.matchScore}%</span>` : ''}</div>`;
        }
      }
    }
  }

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Approve Schedule - ${esc(brief.venue_name)} - BMAsia</title>
<style>
  *{box-sizing:border-box;}
  body{margin:0;padding:24px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f0f23;color:#e5e7eb;}
  .container{max-width:640px;margin:0 auto;}
  .header{text-align:center;margin-bottom:32px;}
  .header h1{margin:0;color:#EFA634;font-size:22px;font-weight:700;}
  .header p{margin:8px 0 0;color:#9ca3af;font-size:14px;}
  .card{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:24px;margin-bottom:20px;}
  .card h2{margin:0 0 16px;font-size:16px;color:#e5e7eb;text-transform:uppercase;letter-spacing:1px;}
  .info-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.05);}
  .info-label{color:#9ca3af;font-size:14px;}
  .info-value{color:#e5e7eb;font-size:14px;font-weight:500;}
  .section-title{font-size:14px;color:#EFA634;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;}
  .zone-header{font-size:15px;font-weight:700;color:#EFA634;margin:16px 0 8px;padding-left:4px;}
  .dp-header{font-size:13px;font-weight:600;color:#a5b4fc;margin:12px 0 4px;padding-left:8px;}
  .dp-time{font-weight:400;color:#6b7280;font-size:12px;}
  .playlist-row{padding:6px 12px;font-size:14px;color:#d1d5db;}
  .match{color:#059669;font-size:12px;font-weight:600;margin-left:8px;}
  .zone-row{margin-bottom:16px;}
  .zone-row label{display:block;font-size:14px;font-weight:600;color:#e5e7eb;margin-bottom:6px;}
  .zone-select,.manual-input{width:100%;padding:10px 12px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:#e5e7eb;font-size:14px;outline:none;}
  .zone-select:focus,.manual-input:focus{border-color:#EFA634;}
  .manual-input{margin-top:8px;}
  option{background:#1a1a2e;color:#e5e7eb;}
  .btn{display:block;width:100%;padding:16px;background:#EFA634;color:#1a1a2e;font-size:16px;font-weight:700;border:none;border-radius:10px;cursor:pointer;text-transform:uppercase;letter-spacing:1px;}
  .btn:hover{background:#d4911f;}
  .no-zones{padding:16px;text-align:center;color:#9ca3af;font-style:italic;}
</style></head><body>
<div class="container">
  <div class="header">
    <h1>${sybScheduleId ? 'Activate Schedule' : 'Approve &amp; Schedule'}</h1>
    <p>${sybScheduleId ? 'A schedule has been pre-built on the client\'s SYB account. Map zones and activate.' : 'Review the music schedule and map SYB zones'}</p>
  </div>

  ${sybScheduleId ? `<div class="card" style="border-color:#166534;background:rgba(22,101,52,0.15);">
    <h2 style="color:#4ade80;margin-bottom:8px;">Schedule Pre-Built</h2>
    <p style="margin:0;color:#86efac;font-size:14px;">The schedule has been created on the client's SYB account and added to their music library. Map the zones below and click Activate to assign it.</p>
  </div>` : ''}

  <div class="card">
    <h2>Brief Summary</h2>
    <div class="info-row"><span class="info-label">Venue</span><span class="info-value">${esc(brief.venue_name)}</span></div>
    <div class="info-row"><span class="info-label">Type</span><span class="info-value">${esc(brief.venue_type || '-')}</span></div>
    <div class="info-row"><span class="info-label">Location</span><span class="info-value">${esc(brief.location || '-')}</span></div>
    <div class="info-row"><span class="info-label">Contact</span><span class="info-value">${esc(brief.contact_name || '-')} ${brief.contact_email ? `(${esc(brief.contact_email)})` : ''}</span></div>
    <div class="info-row"><span class="info-label">Playlists Selected</span><span class="info-value">${likedPlaylists.length}</span></div>
  </div>

  <div class="card">
    <h2>Proposed Schedule</h2>
    ${scheduleHtml || '<div class="no-zones">No playlists selected</div>'}
    ${weekendHtml}
  </div>

  <form method="POST" action="/approve/${esc(token)}">
    <input type="hidden" name="syb_account_id" value="${esc(sybAccountId || '')}">
    <input type="hidden" name="syb_schedule_id" value="${esc(sybScheduleId || '')}">

    <div class="card">
      <h2>Map SYB Zones</h2>
      ${sybZones.length > 0
        ? `<p style="margin:0 0 16px;color:#6b7280;font-size:13px;">Match each area from the brief to a real SYB sound zone.</p>${zoneMappingHtml}`
        : `<div class="no-zones">No SYB account found for "${esc(brief.venue_name)}". Enter zone IDs manually.</div>${zoneMappingHtml}`}
    </div>

    <button type="submit" class="btn">${sybScheduleId ? 'Activate Schedule' : 'Approve &amp; Activate Schedule'}</button>
  </form>
</div>
<script>
function toggleManual(sel, zoneName) {
  const manual = document.getElementById('manual_' + zoneName);
  if (sel.value === '__manual__') {
    manual.style.display = 'block';
    manual.setAttribute('name', sel.name);
    sel.removeAttribute('name');
    manual.focus();
  } else {
    manual.style.display = 'none';
    manual.removeAttribute('name');
    sel.setAttribute('name', 'zone_' + zoneName);
    // Update hidden zone name field
    const opt = sel.options[sel.selectedIndex];
    const nameInput = document.querySelector('input[name="zone_name_' + zoneName + '"]');
    if (nameInput) nameInput.value = opt ? opt.textContent.trim() : '';
  }
}
</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Background Worker — Schedule Executor
// ---------------------------------------------------------------------------
async function sybAssignSource(zoneId, playlistSybId) {
  return sybQuery(`
    mutation($input: SoundZoneAssignSourceInput!) {
      soundZoneAssignSource(input: $input) {
        soundZones
        source { ... on Playlist { id name } }
      }
    }
  `, { input: { soundZones: [zoneId], source: playlistSybId } });
}

async function assignPlaylist(entry) {
  try {
    await sybAssignSource(entry.zone_id, entry.playlist_syb_id);
    await pool.query(
      'UPDATE schedule_entries SET last_assigned_at = NOW(), retry_count = 0 WHERE id = $1',
      [entry.id]
    );
    console.log(`[Worker] Assigned "${entry.playlist_name}" to zone "${entry.zone_name}" (entry ${entry.id})`);
  } catch (err) {
    const retries = (entry.retry_count || 0) + 1;
    console.error(`[Worker] Failed to assign entry ${entry.id} (retry ${retries}/3):`, err.message);
    if (retries >= 3) {
      await pool.query('UPDATE schedule_entries SET status = $1, retry_count = $2 WHERE id = $3', ['error', retries, entry.id]);
    } else {
      await pool.query('UPDATE schedule_entries SET retry_count = $1 WHERE id = $2', [retries, entry.id]);
    }
  }
}

async function scheduleWorker() {
  if (!pool || !process.env.SOUNDTRACK_API_TOKEN) return;

  try {
    // All time comparisons use the entry's own timezone via PostgreSQL AT TIME ZONE.
    // This means schedule times like "08:00" are correctly compared against the current
    // local time in the venue's timezone, not UTC.

    // Find entries due now (within 2-minute window to handle polling gaps)
    const { rows } = await pool.query(`
      SELECT * FROM schedule_entries
      WHERE status = 'active'
        AND start_time BETWEEN
          (NOW() AT TIME ZONE COALESCE(timezone, 'Asia/Bangkok'))::time - interval '1 minute'
          AND (NOW() AT TIME ZONE COALESCE(timezone, 'Asia/Bangkok'))::time + interval '1 minute'
        AND (days = 'daily'
             OR (days = 'weekday' AND EXTRACT(DOW FROM NOW() AT TIME ZONE COALESCE(timezone, 'Asia/Bangkok')) BETWEEN 1 AND 5)
             OR (days = 'weekend' AND EXTRACT(DOW FROM NOW() AT TIME ZONE COALESCE(timezone, 'Asia/Bangkok')) IN (0, 6)))
        AND (last_assigned_at IS NULL
             OR last_assigned_at < (NOW() AT TIME ZONE COALESCE(timezone, 'Asia/Bangkok'))::date)
    `);

    if (rows.length > 0) {
      const localTime = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false });
      console.log(`[Worker] Found ${rows.length} schedule entries to assign at ${localTime} (local)`);
    }

    for (const entry of rows) {
      await assignPlaylist(entry);
    }

    // Check for overdue entries (Render cold start recovery)
    const { rows: overdue } = await pool.query(`
      SELECT * FROM schedule_entries
      WHERE status = 'active'
        AND start_time < (NOW() AT TIME ZONE COALESCE(timezone, 'Asia/Bangkok'))::time
        AND (days = 'daily'
             OR (days = 'weekday' AND EXTRACT(DOW FROM NOW() AT TIME ZONE COALESCE(timezone, 'Asia/Bangkok')) BETWEEN 1 AND 5)
             OR (days = 'weekend' AND EXTRACT(DOW FROM NOW() AT TIME ZONE COALESCE(timezone, 'Asia/Bangkok')) IN (0, 6)))
        AND (last_assigned_at IS NULL
             OR last_assigned_at < (NOW() AT TIME ZONE COALESCE(timezone, 'Asia/Bangkok'))::date)
      ORDER BY start_time DESC
    `);

    // For overdue, only assign the most recent one per zone (latest daypart that should be playing)
    const latestPerZone = {};
    for (const entry of overdue) {
      if (!latestPerZone[entry.zone_id]) {
        latestPerZone[entry.zone_id] = entry;
      }
    }

    for (const entry of Object.values(latestPerZone)) {
      console.log(`[Worker] Catching up overdue entry ${entry.id}: "${entry.playlist_name}" (was due at ${entry.start_time})`);
      await assignPlaylist(entry);
    }

    // Process pending follow-up emails
    await processFollowUps();
  } catch (err) {
    console.error('[Worker] Schedule worker error:', err.message);
  }
}

async function processFollowUps() {
  if (!pool || !GMAIL_USER || !GMAIL_APP_PASSWORD) return;

  try {
    const { rows } = await pool.query(`
      SELECT f.*, b.venue_name, b.contact_name, b.contact_email, b.schedule_data, b.raw_data
      FROM follow_ups f
      JOIN briefs b ON f.brief_id = b.id
      WHERE f.sent_at IS NULL AND f.scheduled_for <= NOW()
      LIMIT 5
    `);

    for (const followUp of rows) {
      if (!followUp.contact_email) {
        await pool.query('UPDATE follow_ups SET sent_at = NOW() WHERE id = $1', [followUp.id]);
        continue;
      }

      try {
        const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        const trackingPixel = followUp.tracking_id
          ? `<img src="${baseUrl}/follow-up/track/${followUp.tracking_id}" width="1" height="1" style="display:block;" alt="">`
          : '';

        const is7Day = followUp.type === '7day';
        const subject = is7Day
          ? `How's the music at ${followUp.venue_name}?`
          : `Time for a music refresh at ${followUp.venue_name}?`;

        const greeting = followUp.contact_name ? `Hi ${followUp.contact_name}` : 'Hello';

        const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
  <tr><td style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);padding:32px 24px;text-align:center;border-radius:12px 12px 0 0;">
    <h1 style="margin:0;color:#fff;font-size:20px;">${is7Day ? 'One Week Check-In' : 'Monthly Music Refresh'}</h1>
    <p style="margin:8px 0 0;color:#a5b4fc;font-size:13px;">${esc(followUp.venue_name)}</p>
  </td></tr>
  <tr><td style="padding:32px 24px;background:#fff;border:1px solid #e5e7eb;border-top:none;">
    <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">${esc(greeting)},</p>
    <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">${is7Day
      ? 'It has been a week since we set up your music atmosphere. We would love to hear how it is working for your venue.'
      : 'It has been a month since your last music design session. Seasons change, and so should your soundtrack.'}</p>
    <p style="margin:0 0 24px;color:#374151;font-size:15px;line-height:1.6;">${is7Day
      ? 'If anything needs adjusting -- energy levels, genre mix, daypart transitions -- just let us know and we will fine-tune it.'
      : 'Would you like to schedule a quick refinement session to keep things fresh?'}</p>
    <div style="text-align:center;">
      <a href="${baseUrl}" style="display:inline-block;padding:14px 32px;background:#EFA634;color:#1a1a2e;font-weight:700;font-size:15px;text-decoration:none;border-radius:8px;">${is7Day ? 'Request Adjustments' : 'Start a Refresh Session'}</a>
    </div>
  </td></tr>
  <tr><td style="padding:20px 24px;text-align:center;background:#1a1a2e;border-radius:0 0 12px 12px;">
    <p style="margin:0;color:#a5b4fc;font-size:12px;">BMAsia Group &bull; Music Atmosphere Design</p>
    ${trackingPixel}
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

        await transporter.sendMail({
          from: `"BMAsia Music Design" <${GMAIL_USER}>`,
          to: followUp.contact_email,
          subject,
          html,
        });

        await pool.query('UPDATE follow_ups SET sent_at = NOW() WHERE id = $1', [followUp.id]);
        console.log(`[Worker] Sent ${followUp.type} follow-up for "${followUp.venue_name}" to ${followUp.contact_email}`);
      } catch (emailErr) {
        console.error(`[Worker] Follow-up email error for ${followUp.id}:`, emailErr.message);
      }
    }
  } catch (err) {
    console.error('[Worker] Follow-up processing error:', err.message);
  }
}

// Self-ping to prevent Render sleep when active schedules exist
let selfPingInterval = null;
async function manageSelfPing() {
  if (!pool) return;
  try {
    const { rows } = await pool.query(
      "SELECT COUNT(*) as count FROM schedule_entries WHERE status = 'active'"
    );
    const hasActive = parseInt(rows[0]?.count || 0, 10) > 0;

    if (hasActive && !selfPingInterval) {
      const baseUrl = process.env.RENDER_EXTERNAL_URL;
      if (baseUrl) {
        selfPingInterval = setInterval(() => {
          fetch(`${baseUrl}/health`).catch(() => {});
        }, 10 * 60 * 1000); // every 10 minutes
        console.log('[Worker] Self-ping activated (active schedules detected)');
      }
    } else if (!hasActive && selfPingInterval) {
      clearInterval(selfPingInterval);
      selfPingInterval = null;
      console.log('[Worker] Self-ping deactivated (no active schedules)');
    }
  } catch (err) {
    // Non-fatal
  }
}

// Start worker on boot
if (pool) {
  setInterval(scheduleWorker, 60_000);
  setInterval(manageSelfPing, 5 * 60_000); // check every 5 min
  console.log('[Worker] Schedule worker started (60s interval)');
}

// ---------------------------------------------------------------------------
// Follow-up tracking pixel
// ---------------------------------------------------------------------------
app.get('/follow-up/track/:trackingId', async (req, res) => {
  // 1x1 transparent GIF
  const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' });
  res.send(pixel);

  // Update opened_at (non-blocking, non-fatal)
  if (pool) {
    pool.query(
      'UPDATE follow_ups SET opened_at = NOW() WHERE tracking_id = $1 AND opened_at IS NULL',
      [req.params.trackingId]
    ).catch(err => console.error('Follow-up tracking error:', err.message));
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`BMAsia Music Brief running on http://localhost:${PORT}`);
  // Pre-load SYB account cache
  if (process.env.SOUNDTRACK_API_TOKEN) {
    refreshSybAccountCache().catch(err => console.error('[SYB] Startup cache failed:', err.message));
  }
});
