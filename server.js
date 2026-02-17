const express = require('express');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const path = require('path');
const dns = require('dns');

dns.setDefaultResultOrder('ipv4first');

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
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { error: 'Too many submissions. Please try again later.' },
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

  const morningEnergy = clamp(energy - 2, 1, 10);
  const afternoonEnergy = clamp(energy, 1, 10);
  const eveningEnergy = clamp(energy + 1, 1, 10);

  return {
    topGenres,
    bpmRanges: [...new Set(bpmRanges)],
    dayparts: {
      morning: { energy: morningEnergy, genres: topGenres.slice(0, 5) },
      afternoon: { energy: afternoonEnergy, genres: topGenres.slice(0, 6) },
      evening: { energy: eveningEnergy, genres: topGenres.slice(0, 6) },
    },
  };
}

// ---------------------------------------------------------------------------
// Email HTML builder
// ---------------------------------------------------------------------------
function buildEmailHtml(data, brief) {
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
      ${daypartRow('Morning', brief.dayparts.morning)}
      ${daypartRow('Afternoon', brief.dayparts.afternoon)}
      ${daypartRow('Evening', brief.dayparts.evening)}
    </table>
  `)}

  ${section('Designer Action Items', `
    <ul style="margin:0;padding:0 0 0 20px;color:#374151;line-height:1.8;">
      <li>Review venue type and vibe selections</li>
      <li>Build ${product === 'Beat Breeze' ? 'custom AI playlist' : 'curated playlist'} based on top genres</li>
      <li>Set up daypart scheduling (morning / afternoon / evening)</li>
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
// Routes
// ---------------------------------------------------------------------------
app.post('/submit', submitLimiter, async (req, res) => {
  try {
    const data = req.body;

    // Honeypot check
    if (data.website) {
      return res.json({ success: true });
    }

    // Basic validation
    if (!data.venueName || !data.vibes || (Array.isArray(data.vibes) && data.vibes.length === 0)) {
      return res.status(400).json({ error: 'Venue name and at least one vibe are required.' });
    }

    const brief = buildDesignerBrief(data);
    const html = buildEmailHtml(data, brief);

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
