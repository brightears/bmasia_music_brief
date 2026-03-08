#!/usr/bin/env node
/**
 * Quick test: sybSearchPlaylists integration
 * Tests that API search finds playlists beyond the static 228 catalog.
 */

const fs = require('fs');
const SYB_API = 'https://api.soundtrackyourbrand.com/v2';

async function sybPublicQuery(query) {
  try {
    const res = await fetch(SYB_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const json = await res.json();
    if (json.errors) throw new Error(json.errors[0].message);
    return json.data;
  } catch (err) {
    console.log('[SYB] Failed:', err.message);
    return null;
  }
}

async function sybSearchPlaylists(keywords, limit = 5) {
  if (!Array.isArray(keywords) || keywords.length === 0) return [];
  const seen = new Set();
  const results = [];
  const searches = keywords.slice(0, 3).map(async (kw) => {
    const data = await sybPublicQuery(`{
      search(query: ${JSON.stringify(kw)}, type: playlist, first: ${limit}) {
        edges { node { ... on Playlist { id name description } } }
      }
    }`);
    return data?.search?.edges?.map(e => e.node).filter(Boolean) || [];
  });
  const allResults = await Promise.all(searches);
  for (const playlists of allResults) {
    for (const p of playlists) {
      if (!p.id || seen.has(p.id)) continue;
      seen.add(p.id);
      results.push({ id: p.id, sybId: p.id, name: p.name, description: p.description || '', categories: [], source: 'api' });
    }
  }
  return results;
}

async function main() {
  const catalog = JSON.parse(fs.readFileSync('data/syb-playlists.json', 'utf8')).playlists;
  const catalogSybIds = new Set(catalog.map(c => c.sybId).filter(Boolean));

  const testCases = [
    ['jazz', 'bossa nova', 'lounge'],
    ['deep house', 'electronic', 'cocktail'],
    ['ambient', 'zen', 'spa'],
    ['indie', 'acoustic', 'coffee'],
  ];

  for (const hints of testCases) {
    console.log(`\nGenre hints: [${hints.join(', ')}]`);
    const start = Date.now();
    const results = await sybSearchPlaylists(hints, 5);
    const elapsed = Date.now() - start;

    const newOnes = results.filter(r => !catalogSybIds.has(r.sybId));
    const existing = results.filter(r => catalogSybIds.has(r.sybId));

    console.log(`  Found ${results.length} playlists in ${elapsed}ms (${existing.length} in catalog, ${newOnes.length} NEW)`);
    for (const p of results.slice(0, 5)) {
      const label = catalogSybIds.has(p.sybId) ? '(catalog)' : '(NEW)';
      console.log(`    ${label} ${p.name}`);
    }
  }
}

main().catch(console.error);
