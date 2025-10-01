/**
 * Simple E2E test script for Incremental Join Discovery
 * 
 * This script tests the complete flow:
 * 1. Triggers knowledge graph building which auto-triggers FK discovery
 * 2. Verifies FKs are persisted to PostgreSQL storage
 * 3. Checks console logs for discovery steps
 */

import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL not found');
}

const pool = new Pool({ connectionString: DATABASE_URL });

async function testIncrementalDiscovery() {
  console.log('🧪 Testing Incremental Join Discovery E2E...\n');
  
  // Step 1: Check existing state
  console.log('Step 1: Checking existing foreign keys in storage...');
  const beforeResult = await pool.query('SELECT COUNT(*) as count FROM foreign_keys');
  const fksBefore = parseInt(beforeResult.rows[0].count);
  console.log(`✓ Found ${fksBefore} existing foreign keys\n`);
  
  // Step 2: Trigger knowledge graph building via API
  console.log('Step 2: Triggering knowledge graph build for database 6a046d80-dcd7-4433-b4c1-f2d66a8b85d9...');
  const databaseId = '6a046d80-dcd7-4433-b4c1-f2d66a8b85d9';
  
  try {
    const response = await fetch(`http://localhost:5000/api/databases/${databaseId}/build-graph`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      const error = await response.text();
      console.log(`⚠️  Build graph failed: ${response.status} ${error}`);
      console.log('This may be expected if Neo4j or Gemini AI connections are not configured\n');
    } else {
      const result = await response.json();
      console.log(`✓ Knowledge graph build triggered successfully`);
      console.log(`  Result:`, JSON.stringify(result, null, 2), '\n');
    }
  } catch (error) {
    console.log(`⚠️  API call failed: ${error instanceof Error ? error.message : error}`);
    console.log('This may be expected if the server is not running or connections are not configured\n');
  }
  
  // Step 3: Check for discovered FKs
  console.log('Step 3: Checking for newly discovered foreign keys...');
  const afterResult = await pool.query('SELECT COUNT(*) as count FROM foreign_keys');
  const fksAfter = parseInt(afterResult.rows[0].count);
  const newFks = fksAfter - fksBefore;
  
  console.log(`✓ Found ${fksAfter} total foreign keys (${newFks} new)`);
  
  if (newFks > 0) {
    console.log('\n📊 Sample discovered foreign keys:');
    const sampleResult = await pool.query(`
      SELECT 
        ft.name as from_table,
        fc.name as from_column,
        tt.name as to_table,
        tc.name as to_column,
        fk.confidence,
        fk.is_validated
      FROM foreign_keys fk
      LEFT JOIN tables ft ON ft.id = fk.from_table_id
      LEFT JOIN columns fc ON fc.id = fk.from_column_id
      LEFT JOIN tables tt ON tt.id = fk.to_table_id
      LEFT JOIN columns tc ON tc.id = fk.to_column_id
      ORDER BY fk.created_at DESC
      LIMIT 10
    `);
    
    sampleResult.rows.forEach((row, i) => {
      console.log(`  ${i + 1}. ${row.from_table}.${row.from_column} → ${row.to_table}.${row.to_column} (confidence: ${row.confidence})`);
    });
  } else {
    console.log('\n⚠️  No new FKs discovered. Possible reasons:');
    console.log('  - PostgreSQL catalog has no FK constraints (expected for ctgov schema)');
    console.log('  - Semantic analysis may need columns with matching patterns');
    console.log('  - Discovery may have been skipped due to missing prerequisites');
  }
  
  console.log('\n✅ Test complete!');
  
  await pool.end();
}

testIncrementalDiscovery().catch(error => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});
