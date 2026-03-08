#!/usr/bin/env node
/**
 * SYB API Capability Discovery
 *
 * Introspects the full GraphQL schema and tests new capabilities:
 * - search (playlists, tracks, categories)
 * - getMusicFromPrompt / getTracksFromPrompt (AI-generated)
 * - browseCategories
 * - blockTrack / unblockTrack
 * - soundZoneQueueTracks
 * - createManualPlaylist
 *
 * Usage:
 *   SOUNDTRACK_API_TOKEN=xxx node scripts/explore-syb-api.js
 */

const SYB_API = 'https://api.soundtrackyourbrand.com/v2';

// BMAsia Demo zone (unpaired, safe for testing)
const TEST_ZONE_ID = 'U291bmRab25lLCwxamw1bDhhdXhvZy9Mb2NhdGlvbiwsMWswaG0zbGJremsvQWNjb3VudCwsMXRzczk1ZnJ0YTgv';
const TEST_ACCOUNT_ID = 'QWNjb3VudCwsMXRzczk1ZnJ0YTgv'; // BMAsia account

async function sybQuery(query, variables = {}, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Basic ${token}`;
  const res = await fetch(SYB_API, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

// -------------------------------------------------------------------
// 1. Full Query Introspection — discover all queries
// -------------------------------------------------------------------
async function discoverQueries(token) {
  console.log('\n' + '='.repeat(60));
  console.log('1. QUERY INTROSPECTION — All available queries');
  console.log('='.repeat(60) + '\n');

  const result = await sybQuery(`query {
    __schema {
      queryType {
        fields {
          name
          description
          args { name type { name kind ofType { name kind } } }
        }
      }
    }
  }`, {}, token);

  if (result.errors) {
    console.log('FAILED:', result.errors[0].message);
    return [];
  }

  const fields = result.data?.__schema?.queryType?.fields || [];
  console.log(`Found ${fields.length} query fields:\n`);

  // Highlight the ones we care about
  const targets = ['search', 'getMusicFromPrompt', 'getTracksFromPrompt',
    'browseCategories', 'browseCategory', 'categories', 'editorial',
    'playlist', 'track', 'recommendations', 'suggest'];

  const relevant = fields.filter(f =>
    targets.some(t => f.name.toLowerCase().includes(t.toLowerCase()))
  );
  const music = fields.filter(f =>
    !relevant.includes(f) && (
      f.name.toLowerCase().includes('music') ||
      f.name.toLowerCase().includes('playlist') ||
      f.name.toLowerCase().includes('track') ||
      f.name.toLowerCase().includes('sound') ||
      f.name.toLowerCase().includes('browse') ||
      f.name.toLowerCase().includes('genre')
    )
  );

  if (relevant.length > 0) {
    console.log('--- TARGET QUERIES (what we are looking for) ---');
    for (const f of relevant) {
      console.log(`  ${f.name}${f.description ? ` — ${f.description}` : ''}`);
      if (f.args?.length) {
        for (const a of f.args) {
          const typeName = a.type?.name || a.type?.ofType?.name || a.type?.kind;
          console.log(`    arg: ${a.name}: ${typeName}`);
        }
      }
    }
    console.log('');
  }

  if (music.length > 0) {
    console.log('--- OTHER MUSIC-RELATED QUERIES ---');
    for (const f of music) {
      console.log(`  ${f.name}${f.description ? ` — ${f.description}` : ''}`);
      if (f.args?.length) {
        for (const a of f.args) {
          const typeName = a.type?.name || a.type?.ofType?.name || a.type?.kind;
          console.log(`    arg: ${a.name}: ${typeName}`);
        }
      }
    }
    console.log('');
  }

  console.log(`--- ALL QUERY NAMES (${fields.length} total) ---`);
  for (const f of fields) {
    const marker = relevant.includes(f) ? ' <<<' : music.includes(f) ? ' <' : '';
    console.log(`  ${f.name}${marker}`);
  }

  return fields;
}

// -------------------------------------------------------------------
// 2. Full Mutation Introspection — discover all mutations
// -------------------------------------------------------------------
async function discoverMutations(token) {
  console.log('\n' + '='.repeat(60));
  console.log('2. MUTATION INTROSPECTION — All available mutations');
  console.log('='.repeat(60) + '\n');

  const result = await sybQuery(`query {
    __schema {
      mutationType {
        fields {
          name
          description
          args { name type { name kind ofType { name kind } } }
        }
      }
    }
  }`, {}, token);

  if (result.errors) {
    console.log('FAILED:', result.errors[0].message);
    return [];
  }

  const fields = result.data?.__schema?.mutationType?.fields || [];
  console.log(`Found ${fields.length} mutations:\n`);

  const targets = ['blockTrack', 'unblockTrack', 'createManualPlaylist',
    'updateManualPlaylist', 'soundZoneQueue', 'queueTrack',
    'addToLibrary', 'removeFromLibrary', 'addToMusicLibrary'];

  const relevant = fields.filter(f =>
    targets.some(t => f.name.toLowerCase().includes(t.toLowerCase()))
  );

  if (relevant.length > 0) {
    console.log('--- TARGET MUTATIONS (what we are looking for) ---');
    for (const f of relevant) {
      console.log(`  ${f.name}${f.description ? ` — ${f.description}` : ''}`);
      if (f.args?.length) {
        for (const a of f.args) {
          const typeName = a.type?.name || a.type?.ofType?.name || a.type?.kind;
          console.log(`    arg: ${a.name}: ${typeName}`);
        }
      }
    }
    console.log('');
  }

  // Show playlist/track/zone related
  const related = fields.filter(f =>
    !relevant.includes(f) && (
      f.name.toLowerCase().includes('playlist') ||
      f.name.toLowerCase().includes('track') ||
      f.name.toLowerCase().includes('zone') ||
      f.name.toLowerCase().includes('schedule') ||
      f.name.toLowerCase().includes('block') ||
      f.name.toLowerCase().includes('queue') ||
      f.name.toLowerCase().includes('library')
    )
  );

  if (related.length > 0) {
    console.log('--- RELATED MUTATIONS ---');
    for (const f of related) {
      console.log(`  ${f.name}${f.description ? ` — ${f.description}` : ''}`);
    }
    console.log('');
  }

  console.log(`--- ALL MUTATION NAMES (${fields.length} total) ---`);
  for (const f of fields) {
    const marker = relevant.includes(f) ? ' <<<' : related.includes(f) ? ' <' : '';
    console.log(`  ${f.name}${marker}`);
  }

  return fields;
}

// -------------------------------------------------------------------
// 3. Test: search (playlists)
// -------------------------------------------------------------------
async function testSearch(token) {
  console.log('\n' + '='.repeat(60));
  console.log('3. TEST: search(type: playlist)');
  console.log('='.repeat(60) + '\n');

  const result = await sybQuery(`{
    search(query: "jazz lounge", type: playlist, first: 5) {
      edges {
        node {
          ... on Playlist { id name description }
        }
      }
    }
  }`, {}, token);

  if (result.errors) {
    console.log('FAILED:', result.errors[0].message);
    return false;
  }

  const playlists = result.data?.search?.edges?.map(e => e.node) || [];
  console.log(`Found ${playlists.length} playlists for "jazz lounge":`);
  for (const p of playlists) {
    console.log(`  - ${p.name} (id: ${p.id?.substring(0, 40)}...)`);
    if (p.description) console.log(`    ${p.description}`);
  }
  return true;
}

// -------------------------------------------------------------------
// 4. Test: search (tracks)
// -------------------------------------------------------------------
async function testTrackSearch(token) {
  console.log('\n' + '='.repeat(60));
  console.log('4. TEST: search(type: track)');
  console.log('='.repeat(60) + '\n');

  const result = await sybQuery(`{
    search(query: "bossa nova", type: track, first: 5) {
      edges {
        node {
          ... on Track { id title artists { name } }
        }
      }
    }
  }`, {}, token);

  if (result.errors) {
    console.log('FAILED:', result.errors[0].message);
    return false;
  }

  const tracks = result.data?.search?.edges?.map(e => e.node) || [];
  console.log(`Found ${tracks.length} tracks for "bossa nova":`);
  for (const t of tracks) {
    const artists = t.artists?.map(a => a.name).join(', ') || 'Unknown';
    console.log(`  - ${t.title} by ${artists}`);
  }
  return true;
}

// -------------------------------------------------------------------
// 5. Test: getMusicFromPrompt (AI-generated playlists)
// Confirmed schema: getMusicFromPrompt(query: String!, context: String,
//   captchaStr: String, offset: Int, limit: Int, trackingId: String)
// Returns: CatalystPlaylistOutput! { playlists: [Playlist!]!, trackingId: String }
// REQUIRES AUTH
// -------------------------------------------------------------------
async function testGetMusicFromPrompt(token) {
  console.log('\n' + '='.repeat(60));
  console.log('5. TEST: getMusicFromPrompt (requires auth)');
  console.log('='.repeat(60) + '\n');

  if (!token) {
    console.log('SKIPPED: No SOUNDTRACK_API_TOKEN (this feature requires auth)');
    return false;
  }

  const result = await sybQuery(`{
    getMusicFromPrompt(query: "sophisticated jazz and bossa nova for hotel lobby evening", limit: 5) {
      playlists { id name description }
      trackingId
    }
  }`, {}, token);

  if (result.errors) {
    console.log('FAILED:', result.errors[0].message);
    return false;
  }

  const playlists = result.data?.getMusicFromPrompt?.playlists || [];
  console.log(`Found ${playlists.length} AI-recommended playlists:`);
  for (const p of playlists) {
    console.log(`  - ${p.name} (id: ${p.id?.substring(0, 40)}...)`);
    if (p.description) console.log(`    ${p.description?.substring(0, 120)}`);
  }
  console.log(`trackingId: ${result.data?.getMusicFromPrompt?.trackingId}`);
  return true;
}

// -------------------------------------------------------------------
// 6. Test: getTracksFromPrompt
// Confirmed schema: getTracksFromPrompt(prompt: String, first: Int, after: String)
// Returns: TracksFromPromptConnection! { edges { node: Track }, total, totalDurationSeconds }
// REQUIRES AUTH
// -------------------------------------------------------------------
async function testGetTracksFromPrompt(token) {
  console.log('\n' + '='.repeat(60));
  console.log('6. TEST: getTracksFromPrompt (requires auth)');
  console.log('='.repeat(60) + '\n');

  if (!token) {
    console.log('SKIPPED: No SOUNDTRACK_API_TOKEN (this feature requires auth)');
    return false;
  }

  const result = await sybQuery(`{
    getTracksFromPrompt(prompt: "relaxing bossa nova instrumental", first: 5) {
      edges { node { id title artists { name } } }
      total
      totalDurationSeconds
    }
  }`, {}, token);

  if (result.errors) {
    console.log('FAILED:', result.errors[0].message);
    return false;
  }

  const tracks = result.data?.getTracksFromPrompt?.edges?.map(e => e.node) || [];
  const total = result.data?.getTracksFromPrompt?.total;
  console.log(`Found ${tracks.length} tracks (${total} total):`);
  for (const t of tracks) {
    const artists = t.artists?.map(a => a.name).join(', ') || 'Unknown';
    console.log(`  - ${t.title} by ${artists}`);
  }
  return true;
}

// -------------------------------------------------------------------
// 7. Test: browseCategories
// Confirmed schema: browseCategories(first: Int, after: String)
// Returns: BrowseCategoryDisplayableConnection { edges { node { id, name, slug, type, color } } }
// Category types: genre, business, energy, sound, decade, chart, category, unknown
// 250 categories available. Works WITHOUT auth.
// browseCategory(id).playlists requires auth.
// -------------------------------------------------------------------
async function testBrowseCategories(token) {
  console.log('\n' + '='.repeat(60));
  console.log('7. TEST: browseCategories + browseCategory playlists');
  console.log('='.repeat(60) + '\n');

  // List categories (works without auth)
  const result = await sybQuery(`{
    browseCategories(first: 20) {
      edges { node { id name slug type } }
    }
  }`, {}, token);

  if (result.errors) {
    console.log('List FAILED:', result.errors[0].message);
    return false;
  }

  const cats = result.data?.browseCategories?.edges?.map(e => e.node) || [];
  console.log(`Categories (first 20 of 250+):`);
  for (const c of cats) {
    console.log(`  ${c.name} (type: ${c.type}, id: ${c.id})`);
  }

  // Try browsing playlists within a category (may need auth)
  console.log('\nBrowsing Jazz category playlists...');
  const r2 = await sybQuery(`{
    browseCategory(id: "jazz") {
      name
      playlists(first: 5) {
        edges { node { ... on Playlist { id name description } } }
      }
    }
  }`, {}, token);

  if (r2.errors) {
    console.log('Browse playlists FAILED:', r2.errors[0].message);
  } else {
    const pls = r2.data?.browseCategory?.playlists?.edges?.map(e => e.node) || [];
    if (pls.length > 0) {
      console.log(`Jazz playlists:`);
      for (const p of pls) console.log(`  - ${p.name}`);
    } else {
      console.log('Jazz playlists: empty (may require auth)');
    }
  }

  return true;
}

// -------------------------------------------------------------------
// 8. Test: blockTrack mutation
// -------------------------------------------------------------------
async function testBlockTrackSchema(token) {
  console.log('\n' + '='.repeat(60));
  console.log('8. TEST: blockTrack mutation schema');
  console.log('='.repeat(60) + '\n');

  if (!token) {
    console.log('SKIPPED: No SOUNDTRACK_API_TOKEN');
    return false;
  }

  // First check if blockTrack exists via introspection
  const introResult = await sybQuery(`{
    __type(name: "Mutation") {
      fields {
        name
        args { name type { name kind ofType { name kind } } }
        type { name kind ofType { name kind } }
      }
    }
  }`, {}, token);

  if (introResult.errors) {
    console.log('Introspection failed:', introResult.errors[0].message);
    return false;
  }

  const mutations = introResult.data?.__type?.fields || [];
  const blockRelated = mutations.filter(f =>
    f.name.toLowerCase().includes('block')
  );

  if (blockRelated.length > 0) {
    console.log('Block-related mutations found:');
    for (const m of blockRelated) {
      console.log(`\n  ${m.name}`);
      console.log(`  Return type: ${m.type?.name || m.type?.ofType?.name || 'unknown'}`);
      for (const a of (m.args || [])) {
        const typeName = a.type?.name || a.type?.ofType?.name || a.type?.kind;
        console.log(`    arg: ${a.name}: ${typeName}`);
      }
    }
    return true;
  } else {
    console.log('No block-related mutations found');
    return false;
  }
}

// -------------------------------------------------------------------
// 9. Test: soundZoneQueueTracks mutation
// -------------------------------------------------------------------
async function testQueueTracksSchema(token) {
  console.log('\n' + '='.repeat(60));
  console.log('9. TEST: soundZoneQueueTracks mutation schema');
  console.log('='.repeat(60) + '\n');

  if (!token) {
    console.log('SKIPPED: No SOUNDTRACK_API_TOKEN');
    return false;
  }

  const introResult = await sybQuery(`{
    __type(name: "Mutation") {
      fields {
        name
        args { name type { name kind ofType { name kind } } }
      }
    }
  }`, {}, token);

  if (introResult.errors) {
    console.log('Introspection failed');
    return false;
  }

  const mutations = introResult.data?.__type?.fields || [];
  const queueRelated = mutations.filter(f =>
    f.name.toLowerCase().includes('queue')
  );

  if (queueRelated.length > 0) {
    console.log('Queue-related mutations found:');
    for (const m of queueRelated) {
      console.log(`\n  ${m.name}`);
      for (const a of (m.args || [])) {
        const typeName = a.type?.name || a.type?.ofType?.name || a.type?.kind;
        console.log(`    arg: ${a.name}: ${typeName}`);
      }
    }
    return true;
  } else {
    console.log('No queue-related mutations found');
    return false;
  }
}

// -------------------------------------------------------------------
// 10. Test: createManualPlaylist
// -------------------------------------------------------------------
async function testCreateManualPlaylistSchema(token) {
  console.log('\n' + '='.repeat(60));
  console.log('10. TEST: createManualPlaylist mutation schema');
  console.log('='.repeat(60) + '\n');

  if (!token) {
    console.log('SKIPPED: No SOUNDTRACK_API_TOKEN');
    return false;
  }

  const introResult = await sybQuery(`{
    __type(name: "Mutation") {
      fields {
        name
        args { name type { name kind ofType { name kind } } }
      }
    }
  }`, {}, token);

  if (introResult.errors) {
    console.log('Introspection failed');
    return false;
  }

  const mutations = introResult.data?.__type?.fields || [];
  const playlistRelated = mutations.filter(f =>
    f.name.toLowerCase().includes('playlist') ||
    f.name.toLowerCase().includes('manual')
  );

  if (playlistRelated.length > 0) {
    console.log('Playlist creation mutations found:');
    for (const m of playlistRelated) {
      console.log(`\n  ${m.name}`);
      for (const a of (m.args || [])) {
        const typeName = a.type?.name || a.type?.ofType?.name || a.type?.kind;
        console.log(`    arg: ${a.name}: ${typeName}`);
      }
    }
    return true;
  } else {
    console.log('No playlist creation mutations found');
    return false;
  }
}

// -------------------------------------------------------------------
// 11. Deep-dive input types for discovered features
// -------------------------------------------------------------------
async function inspectInputType(typeName, token) {
  const result = await sybQuery(`{
    __type(name: "${typeName}") {
      name
      kind
      inputFields {
        name
        type { name kind ofType { name kind ofType { name kind } } }
        defaultValue
      }
    }
  }`, {}, token);

  if (result.errors || !result.data?.__type) return null;
  return result.data.__type;
}

// -------------------------------------------------------------------
// Main
// -------------------------------------------------------------------
async function main() {
  try { (await import('dotenv')).config(); } catch {}

  const token = process.env.SOUNDTRACK_API_TOKEN;
  console.log('SYB API Capability Discovery');
  console.log('============================');
  console.log(`Token: ${token ? `${token.substring(0, 8)}...` : 'NOT SET'}`);
  console.log(`Date: ${new Date().toISOString()}`);

  const results = {};

  // 1-2: Schema introspection
  const queries = await discoverQueries(token);
  const mutations = await discoverMutations(token);

  // 3-7: Feature tests
  results.search = await testSearch(token);
  results.trackSearch = await testTrackSearch(token);
  results.getMusicFromPrompt = await testGetMusicFromPrompt(token);
  results.getTracksFromPrompt = await testGetTracksFromPrompt(token);
  results.browseCategories = await testBrowseCategories(token);

  // 8-10: Mutation schema discovery
  results.blockTrack = await testBlockTrackSchema(token);
  results.queueTracks = await testQueueTracksSchema(token);
  results.createManualPlaylist = await testCreateManualPlaylistSchema(token);

  // Deep-dive on discovered input types
  const inputTypesToInspect = [
    'BlockTrackInput', 'UnblockTrackInput',
    'SoundZoneQueueTracksInput', 'SoundZoneClearQueuedTracksInput',
    'CreateManualPlaylistInput', 'UpdateManualPlaylistInput',
    'AddToMusicLibraryInput',
  ];

  console.log('\n' + '='.repeat(60));
  console.log('11. INPUT TYPE INSPECTION');
  console.log('='.repeat(60) + '\n');

  for (const typeName of inputTypesToInspect) {
    const typeInfo = await inspectInputType(typeName, token);
    if (typeInfo) {
      console.log(`${typeName}:`);
      for (const field of (typeInfo.inputFields || [])) {
        const ft = field.type?.name || field.type?.ofType?.name || field.type?.ofType?.ofType?.name || field.type?.kind;
        console.log(`  ${field.name}: ${ft}${field.defaultValue ? ` (default: ${field.defaultValue})` : ''}`);
      }
      console.log('');
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60) + '\n');

  for (const [feature, works] of Object.entries(results)) {
    console.log(`  ${works ? 'YES' : 'NO '}  ${feature}`);
  }

  console.log(`\nQueries: ${queries.length} | Mutations: ${mutations.length}`);
  console.log('\nDone.');
}

main().catch(console.error);
