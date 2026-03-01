-- BMASia Music Brief — Database Schema
-- Run once against the PostgreSQL instance to initialize tables.
-- Safe to re-run: uses IF NOT EXISTS / ADD IF NOT EXISTS throughout.

-- ==========================================================================
-- Core tables
-- ==========================================================================

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
  status VARCHAR(20) DEFAULT 'submitted',    -- submitted/approved/scheduled/completed
  schedule_data JSONB,                        -- snapshot of dayparts+playlists at approval time
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS venues (
  id SERIAL PRIMARY KEY,
  venue_name VARCHAR(255) UNIQUE NOT NULL,
  location TEXT,
  venue_type VARCHAR(50),
  syb_account_id VARCHAR(255),
  latest_brief_id INTEGER REFERENCES briefs(id),
  auto_schedule BOOLEAN DEFAULT FALSE,
  approved_brief_count INTEGER DEFAULT 0,
  timezone VARCHAR(50) DEFAULT 'Asia/Bangkok',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_venues_name ON venues(venue_name);
CREATE INDEX IF NOT EXISTS idx_briefs_venue ON briefs(venue_name);
CREATE INDEX IF NOT EXISTS idx_briefs_email ON briefs(contact_email);

-- ==========================================================================
-- Scheduling pipeline tables
-- ==========================================================================

-- One entry per daypart per zone — the background worker operates on these
CREATE TABLE IF NOT EXISTS schedule_entries (
  id SERIAL PRIMARY KEY,
  brief_id INTEGER REFERENCES briefs(id),
  zone_id VARCHAR(255) NOT NULL,          -- SYB zone ID (Base64 encoded)
  zone_name VARCHAR(255),                 -- human-readable zone name
  playlist_syb_id VARCHAR(255) NOT NULL,  -- from syb-playlists.json sybId field
  playlist_name VARCHAR(255),
  start_time TIME NOT NULL,               -- e.g. '09:00'
  end_time TIME,                          -- e.g. '12:00' (for display only; worker triggers on start_time)
  days VARCHAR(20) DEFAULT 'daily',       -- 'daily', 'weekday', 'weekend'
  timezone VARCHAR(50) DEFAULT 'Asia/Bangkok', -- venue timezone for worker time comparisons
  status VARCHAR(20) DEFAULT 'active',    -- active/paused/completed/error
  last_assigned_at TIMESTAMP,
  retry_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Short-lived tokens for email approval links
CREATE TABLE IF NOT EXISTS approval_tokens (
  id SERIAL PRIMARY KEY,
  brief_id INTEGER REFERENCES briefs(id),
  token VARCHAR(64) UNIQUE NOT NULL,      -- crypto.randomBytes(32).toString('hex')
  expires_at TIMESTAMP NOT NULL,          -- 7 days from creation
  used_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Follow-up email tracking
CREATE TABLE IF NOT EXISTS follow_ups (
  id SERIAL PRIMARY KEY,
  brief_id INTEGER REFERENCES briefs(id),
  type VARCHAR(20) NOT NULL,              -- '7day', '30day'
  scheduled_for TIMESTAMP NOT NULL,
  sent_at TIMESTAMP,
  tracking_id VARCHAR(64) UNIQUE,         -- for open-tracking pixel
  created_at TIMESTAMP DEFAULT NOW()
);

-- Maps conversation zone names to real SYB zone IDs
CREATE TABLE IF NOT EXISTS venue_zone_mappings (
  id SERIAL PRIMARY KEY,
  venue_name VARCHAR(255) NOT NULL,
  brief_zone_name VARCHAR(255) NOT NULL,  -- "Lobby", "Restaurant" from conversation
  syb_zone_id VARCHAR(255) NOT NULL,      -- actual SYB zone ID
  syb_zone_name VARCHAR(255),             -- SYB zone display name
  syb_account_id VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(venue_name, brief_zone_name)
);

CREATE INDEX IF NOT EXISTS idx_schedule_active ON schedule_entries(status, start_time) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_approval_token ON approval_tokens(token);
CREATE INDEX IF NOT EXISTS idx_followup_pending ON follow_ups(scheduled_for) WHERE sent_at IS NULL;

-- ==========================================================================
-- Migration helpers (safe to re-run)
-- ==========================================================================

ALTER TABLE briefs ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'submitted';
ALTER TABLE briefs ADD COLUMN IF NOT EXISTS schedule_data JSONB;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS auto_schedule BOOLEAN DEFAULT FALSE;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS approved_brief_count INTEGER DEFAULT 0;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS timezone VARCHAR(50) DEFAULT 'Asia/Bangkok';
ALTER TABLE schedule_entries ADD COLUMN IF NOT EXISTS timezone VARCHAR(50) DEFAULT 'Asia/Bangkok';
ALTER TABLE briefs ADD COLUMN IF NOT EXISTS syb_account_id VARCHAR(255);
ALTER TABLE briefs ADD COLUMN IF NOT EXISTS syb_schedule_id VARCHAR(255);
ALTER TABLE briefs ADD COLUMN IF NOT EXISTS automation_tier INTEGER;
