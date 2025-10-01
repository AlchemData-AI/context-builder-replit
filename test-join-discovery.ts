/**
 * Test script for incremental join discovery
 * Tests the complete flow: select tables → discover FKs → build graph
 */

import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL not found');
}

const pool = new Pool({ connectionString: DATABASE_URL });
const TEST_DATABASE_ID = '6a046d80-dcd7-4433-b4c1-f2d66a8b85d9';

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testJoinDiscovery() {
  console.log('🧪 Testing Incremental Join Discovery with Real Data\n');
  console.log('════════════════════════════════════════════════════\n');
  
  // Step 1: Verify selected tables
  console.log('Step 1: Verifying selected tables...');
  const tablesResult = await pool.query(`
    SELECT name, schema, row_count, 
           (SELECT COUNT(*) FROM columns WHERE table_id = t.id) as column_count
    FROM tables t
    WHERE database_id = $1 AND is_selected = true
  `, [TEST_DATABASE_ID]);
  
  console.log(`✓ Found ${tablesResult.rows.length} selected tables:`);
  tablesResult.rows.forEach(row => {
    console.log(`  - ${row.schema}.${row.name} (${row.column_count} columns, ${row.row_count?.toLocaleString()} rows)`);
  });
  console.log();
  
  // Step 2: Check existing FKs
  console.log('Step 2: Checking existing foreign keys...');
  const fksBefore = await pool.query(`
    SELECT COUNT(*) as count FROM foreign_keys 
    WHERE from_table_id IN (
      SELECT id FROM tables WHERE database_id = $1
    )
  `, [TEST_DATABASE_ID]);
  console.log(`✓ Current FK count: ${fksBefore.rows[0].count}\n`);
  
  // Step 3: Trigger knowledge graph build
  console.log('Step 3: Triggering knowledge graph build...');
  console.log('(This will auto-trigger incremental join discovery)');
  
  try {
    const response = await fetch(`http://localhost:5000/api/databases/${TEST_DATABASE_ID}/build-graph`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (!response.ok) {
      const error = await response.text();
      console.log(`⚠️  Build graph failed: ${response.status}`);
      console.log(`Error: ${error}\n`);
      return;
    }
    
    const result = await response.json();
    console.log(`✓ Knowledge graph build started`);
    console.log(`  Namespace: database_${TEST_DATABASE_ID}`);
    console.log();
    
    // Wait a moment for processing
    console.log('⏳ Waiting 5 seconds for join discovery to complete...');
    await sleep(5000);
    
  } catch (error) {
    console.log(`❌ API call failed: ${error instanceof Error ? error.message : error}\n`);
    return;
  }
  
  // Step 4: Check discovered FKs
  console.log('\nStep 4: Checking discovered foreign keys...');
  const fksAfter = await pool.query(`
    SELECT COUNT(*) as count FROM foreign_keys 
    WHERE from_table_id IN (
      SELECT id FROM tables WHERE database_id = $1
    )
  `, [TEST_DATABASE_ID]);
  
  const newFkCount = parseInt(fksAfter.rows[0].count) - parseInt(fksBefore.rows[0].count);
  console.log(`✓ Total FK count: ${fksAfter.rows[0].count} (${newFkCount} newly discovered)\n`);
  
  if (newFkCount > 0) {
    console.log('📊 Discovered Foreign Keys:');
    console.log('─────────────────────────────────────────────────');
    const fkDetails = await pool.query(`
      SELECT 
        ft.schema || '.' || ft.name as from_table,
        fc.name as from_column,
        tt.schema || '.' || tt.name as to_table,
        tc.name as to_column,
        fk.confidence,
        fk.is_validated
      FROM foreign_keys fk
      JOIN tables ft ON ft.id = fk.from_table_id
      JOIN columns fc ON fc.id = fk.from_column_id
      JOIN tables tt ON tt.id = fk.to_table_id
      JOIN columns tc ON tc.id = fk.to_column_id
      WHERE ft.database_id = $1
      ORDER BY fk.confidence DESC, ft.name, fc.name
    `, [TEST_DATABASE_ID]);
    
    fkDetails.rows.forEach((fk, i) => {
      console.log(`${i + 1}. ${fk.from_table}.${fk.from_column}`);
      console.log(`   → ${fk.to_table}.${fk.to_column}`);
      console.log(`   Confidence: ${parseFloat(fk.confidence).toFixed(2)} | Validated: ${fk.is_validated}`);
      console.log();
    });
  } else {
    console.log('⚠️  No foreign keys discovered.');
    console.log('This could happen if:');
    console.log('  - PostgreSQL catalog has no FK constraints (expected for ctgov)');
    console.log('  - Semantic analysis confidence thresholds not met');
    console.log('  - Join discovery needs more time to complete\n');
  }
  
  console.log('════════════════════════════════════════════════════');
  console.log('✅ Test complete!\n');
  
  await pool.end();
}

testJoinDiscovery().catch(error => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});
