-- BMASia Music Brief — Database Schema
-- Run once against the PostgreSQL instance to initialize tables.

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
