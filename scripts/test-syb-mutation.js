#!/usr/bin/env node
/**
 * Test SYB API mutation access
 *
 * Tests whether our SOUNDTRACK_API_TOKEN can:
 * 1. Run GraphQL introspection to discover available mutations
 * 2. Execute soundZoneAssignSource mutation
 *
 * Usage:
 *   SOUNDTRACK_API_TOKEN=xxx node scripts/test-syb-mutation.js
 *   (or set in .env and run: node -e "require('dotenv').config()" && node scripts/test-syb-mutation.js)
 */

const SYB_API = 'https://api.soundtrackyourbrand.com/v2';

// BMAsia Demo zones (unpaired, safe for testing)
const TEST_ZONE_ID = 'U291bmRab25lLCwxamw1bDhhdXhvZy9Mb2NhdGlvbiwsMWswaG0zbGJremsvQWNjb3VudCwsMXRzczk1ZnJ0YTgv';
const TEST_ZONE_NAME = 'Demo 1';

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
// Test 1: GraphQL Introspection — discover all mutations
// -------------------------------------------------------------------
async function testIntrospection(token) {
  console.log('\n=== Test 1: GraphQL Introspection (Mutations) ===\n');

  const query = `query {
    __schema {
      mutationType {
        fields {
          name
          description
          args { name type { name kind ofType { name } } }
        }
      }
    }
  }`;

  const result = await sybQuery(query, {}, token);

  if (result.errors) {
    console.log('Introspection FAILED:', result.errors[0].message);
    return false;
  }

  const mutations = result.data?.__schema?.mutationType?.fields || [];
  console.log(`Found ${mutations.length} mutations:\n`);

  // Group by relevance
  const relevant = mutations.filter(m =>
    m.name.toLowerCase().includes('sound') ||
    m.name.toLowerCase().includes('zone') ||
    m.name.toLowerCase().includes('playlist') ||
    m.name.toLowerCase().includes('schedule') ||
    m.name.toLowerCase().includes('assign') ||
    m.name.toLowerCase().includes('source')
  );

  const other = mutations.filter(m => !relevant.includes(m));

  if (relevant.length > 0) {
    console.log('--- Relevant mutations (sound/zone/playlist/schedule) ---');
    for (const m of relevant) {
      console.log(`  ${m.name}`);
      if (m.description) console.log(`    ${m.description}`);
      if (m.args?.length) {
        console.log(`    Args: ${m.args.map(a => `${a.name}: ${a.type?.name || a.type?.ofType?.name || a.type?.kind}`).join(', ')}`);
      }
    }
  }

  console.log(`\n--- All other mutations (${other.length}) ---`);
  for (const m of other) {
    console.log(`  ${m.name}${m.description ? ` — ${m.description}` : ''}`);
  }

  return true;
}

// -------------------------------------------------------------------
// Test 2: soundZoneAssignSource mutation
// -------------------------------------------------------------------
async function testAssignSource(token) {
  console.log('\n=== Test 2: soundZoneAssignSource Mutation ===\n');

  if (!token) {
    console.log('SKIPPED: No SOUNDTRACK_API_TOKEN provided');
    return false;
  }

  // First, find a playlist to assign from our catalog
  const fs = await import('fs');
  const path = await import('path');
  const catalogPath = path.join(process.cwd(), 'data', 'syb-playlists.json');

  let testPlaylistId;
  try {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    // Pick a safe test playlist (first one with a sybId)
    const withSybId = catalog.filter(p => p.sybId);
    if (withSybId.length > 0) {
      const playlist = withSybId[0];
      // Decode sybId to extract Collection ID
      const decoded = Buffer.from(playlist.sybId, 'base64').toString('utf8');
      const collectionMatch = decoded.match(/Collection,([^,]+)/);
      testPlaylistId = collectionMatch ? collectionMatch[1] : null;
      console.log(`Test playlist: "${playlist.name}" (sybId available)`);
      console.log(`Decoded sybId: ${decoded.substring(0, 80)}...`);
      if (testPlaylistId) console.log(`Extracted collection ID: ${testPlaylistId}`);
    }
  } catch (e) {
    console.log('Could not load playlist catalog:', e.message);
  }

  // Try the mutation with the zone and a playlist source
  // The source ID format for SYB might need to be the full collection URI
  const mutation = `
    mutation($soundZone: ID!, $source: ID!) {
      soundZoneAssignSource(input: { soundZone: $soundZone, source: $source }) {
        soundZone {
          id
          name
          nowPlaying { title }
        }
      }
    }
  `;

  // Try with the collection ID if we have one
  if (testPlaylistId) {
    console.log(`\nAttempting mutation: zone=${TEST_ZONE_NAME}, source=${testPlaylistId}`);
    const result = await sybQuery(mutation, { soundZone: TEST_ZONE_ID, source: testPlaylistId }, token);

    if (result.errors) {
      console.log('Mutation FAILED:', JSON.stringify(result.errors, null, 2));

      // Check error type
      const errMsg = result.errors[0]?.message?.toLowerCase() || '';
      if (errMsg.includes('unauthorized') || errMsg.includes('forbidden') || errMsg.includes('permission')) {
        console.log('\n>>> RESULT: Token does NOT have mutation access <<<');
      } else if (errMsg.includes('not found') || errMsg.includes('invalid')) {
        console.log('\n>>> RESULT: Token HAS mutation access, but source/zone ID format is wrong <<<');
        console.log('This is good news — we just need to fix the ID format.');
      } else {
        console.log('\n>>> RESULT: Unclear — error may be type/format related <<<');
      }
    } else {
      console.log('Mutation SUCCEEDED!');
      console.log('Result:', JSON.stringify(result.data, null, 2));
      console.log('\n>>> RESULT: Token HAS full mutation access <<<');
    }

    return !result.errors;
  } else {
    console.log('No test playlist ID available, skipping mutation test');
    return false;
  }
}

// -------------------------------------------------------------------
// Test 3: Search for a playlist via API to get the correct source ID format
// -------------------------------------------------------------------
async function testPlaylistSearch(token) {
  console.log('\n=== Test 3: Playlist Search (find correct source ID format) ===\n');

  const query = `query {
    search(query: "Morning Lofi", type: playlist, first: 3) {
      edges {
        node {
          ... on Playlist {
            id
            name
            uri
          }
        }
      }
    }
  }`;

  const result = await sybQuery(query, {}, token);

  if (result.errors) {
    console.log('Search FAILED:', result.errors[0].message);
    return null;
  }

  const playlists = result.data?.search?.edges?.map(e => e.node) || [];
  console.log(`Found ${playlists.length} playlists:`);
  for (const p of playlists) {
    console.log(`  ID: ${p.id}`);
    console.log(`  Name: ${p.name}`);
    if (p.uri) console.log(`  URI: ${p.uri}`);
    console.log('');
  }

  return playlists[0]?.id || null;
}

// -------------------------------------------------------------------
// Main
// -------------------------------------------------------------------
async function main() {
  // Load .env if available
  try { (await import('dotenv')).config(); } catch {}

  const token = process.env.SOUNDTRACK_API_TOKEN;
  console.log('SYB API Mutation Access Test');
  console.log('============================');
  console.log(`Token: ${token ? `${token.substring(0, 8)}...` : 'NOT SET'}`);
  console.log(`Target zone: ${TEST_ZONE_NAME} (${TEST_ZONE_ID.substring(0, 30)}...)`);

  // Run introspection (may work without token)
  await testIntrospection(token);

  // Search for playlist to get correct ID format
  const searchedId = await testPlaylistSearch(token);

  // Try mutation
  await testAssignSource(token);

  // If we got a searched ID, try mutation with that format too
  if (searchedId && token) {
    console.log('\n=== Test 4: Mutation with API-returned playlist ID ===\n');
    const mutation = `
      mutation($soundZone: ID!, $source: ID!) {
        soundZoneAssignSource(input: { soundZone: $soundZone, source: $source }) {
          soundZone { id name nowPlaying { title } }
        }
      }
    `;
    console.log(`Attempting: zone=${TEST_ZONE_NAME}, source=${searchedId}`);
    const result = await sybQuery(mutation, { soundZone: TEST_ZONE_ID, source: searchedId }, token);
    if (result.errors) {
      console.log('Mutation FAILED:', JSON.stringify(result.errors, null, 2));
    } else {
      console.log('Mutation SUCCEEDED:', JSON.stringify(result.data, null, 2));
    }
  }

  console.log('\n============================');
  console.log('Test complete.');
}

main().catch(console.error);
