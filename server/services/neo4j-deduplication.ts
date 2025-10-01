import { neo4jService } from './neo4j-service';
import { storage } from '../storage';
import { EnvironmentService } from './environment-service';

const environmentService = EnvironmentService.getInstance();

export interface DeduplicationResult {
  success: boolean;
  tablesMerged: number;
  columnsMerged: number;
  valuesMerged: number;
  errors: string[];
  details: string[];
}

export class Neo4jDeduplicationService {
  /**
   * Deduplicate nodes by merging duplicates with same canonical keys
   * Preserves all relationships and context from merged nodes
   */
  async deduplicateNodes(): Promise<DeduplicationResult> {
    const result: DeduplicationResult = {
      success: true,
      tablesMerged: 0,
      columnsMerged: 0,
      valuesMerged: 0,
      errors: [],
      details: []
    };

    let neo4jConnected = false;

    try {
      // Connect to Neo4j
      const neo4jConnectionId = environmentService.getNeo4jConnectionId();
      const neo4jConnection = await storage.getConnection(neo4jConnectionId);

      if (!neo4jConnection) {
        throw new Error('Neo4j connection not found');
      }

      neo4jConnected = await neo4jService.connect(neo4jConnection.config as any);

      if (!neo4jConnected) {
        throw new Error('Failed to connect to Neo4j');
      }

      console.log('🔄 Starting node deduplication...');

      // Deduplicate Table nodes
      const tableResults = await this.deduplicateTableNodes();
      result.tablesMerged = tableResults.merged;
      result.details.push(...tableResults.details);
      console.log(`✅ Merged ${tableResults.merged} duplicate Table nodes`);

      // Deduplicate Column nodes
      const columnResults = await this.deduplicateColumnNodes();
      result.columnsMerged = columnResults.merged;
      result.details.push(...columnResults.details);
      console.log(`✅ Merged ${columnResults.merged} duplicate Column nodes`);

      // Deduplicate Value nodes (if needed in the future)
      result.valuesMerged = 0;

      console.log(`✅ Deduplication completed successfully`);
    } catch (error) {
      result.success = false;
      const errorMessage = error instanceof Error ? error.message : String(error);
      result.errors.push(errorMessage);
      console.error('❌ Deduplication failed:', errorMessage);
    } finally {
      if (neo4jConnected) {
        await neo4jService.disconnect();
      }
    }

    return result;
  }

  /**
   * Deduplicate Table nodes with the same canonicalKey
   * Strategy: Keep first node, merge relationships and properties to it, delete duplicates
   */
  private async deduplicateTableNodes(): Promise<{ merged: number; details: string[] }> {
    const details: string[] = [];
    
    // Find duplicate groups (tables with same canonicalKey)
    const findDuplicatesQuery = `
      MATCH (t:Table)
      WHERE t.canonicalKey IS NOT NULL
      WITH t.canonicalKey AS key, collect(t) AS nodes
      WHERE size(nodes) > 1
      RETURN key, nodes
    `;

    const duplicatesResult = await neo4jService.executeQuery(findDuplicatesQuery);
    let totalMerged = 0;

    for (const record of duplicatesResult.records) {
      const key = record.get('key');
      const nodes = record.get('nodes');
      
      if (!nodes || nodes.length <= 1) continue;

      // Keep the first node as canonical, merge others into it
      const canonicalNode = nodes[0];
      const duplicateNodes = nodes.slice(1);

      for (const duplicateNode of duplicateNodes) {
        try {
          // Merge relationships from duplicate to canonical
          const mergeQuery = `
            MATCH (dup:Table {id: $dupId})
            MATCH (canon:Table {id: $canonId})
            
            // Transfer all incoming relationships
            OPTIONAL MATCH (other)-[r]->(dup)
            WHERE other.id <> $canonId
            WITH canon, dup, other, r, type(r) as relType, properties(r) as relProps
            WHERE other IS NOT NULL
            FOREACH (_ IN CASE WHEN other IS NOT NULL THEN [1] ELSE [] END |
              CREATE (other)-[newR:DUMMY]->(canon)
              SET newR = relProps
            )
            
            // Transfer all outgoing relationships
            WITH canon, dup
            OPTIONAL MATCH (dup)-[r2]->(other2)
            WHERE other2.id <> $canonId
            WITH canon, dup, other2, r2, type(r2) as relType2, properties(r2) as relProps2
            WHERE other2 IS NOT NULL
            FOREACH (_ IN CASE WHEN other2 IS NOT NULL THEN [1] ELSE [] END |
              CREATE (canon)-[newR2:DUMMY]->(other2)
              SET newR2 = relProps2
            )
            
            // Merge properties (keep non-null values)
            WITH canon, dup
            SET canon.description = CASE 
              WHEN canon.description IS NULL THEN dup.description
              WHEN dup.description IS NOT NULL AND length(dup.description) > length(coalesce(canon.description, ''))
              THEN dup.description
              ELSE canon.description
            END,
            canon.rowCount = coalesce(canon.rowCount, dup.rowCount),
            canon.columnCount = coalesce(canon.columnCount, dup.columnCount)
            
            // Delete duplicate node
            DETACH DELETE dup
            
            RETURN canon.id as canonId, count(*) as merged
          `;

          // Execute merge with proper relationship type handling
          await this.mergeDuplicateTable(canonicalNode.properties.id, duplicateNode.properties.id);
          totalMerged++;
          
          const detail = `Merged duplicate table ${key}: ${duplicateNode.properties.id} -> ${canonicalNode.properties.id}`;
          details.push(detail);
          console.log(`  ${detail}`);
        } catch (error) {
          const errorDetail = `Failed to merge table duplicate for ${key}: ${error instanceof Error ? error.message : error}`;
          details.push(errorDetail);
          console.error(`  ${errorDetail}`);
        }
      }
    }

    return { merged: totalMerged, details };
  }

  /**
   * Helper method to properly merge duplicate table nodes with comprehensive relationship handling
   */
  private async mergeDuplicateTable(canonId: string, dupId: string): Promise<void> {
    // Transfer CONTAINS relationships from personas (incoming)
    await neo4jService.executeQuery(`
      MATCH (p:AgentPersona)-[r:CONTAINS]->(dup:Table {id: $dupId})
      MATCH (canon:Table {id: $canonId})
      WHERE NOT EXISTS((p)-[:CONTAINS]->(canon))
      CREATE (p)-[newR:CONTAINS]->(canon)
      SET newR = properties(r)
    `, { dupId, canonId });

    // Transfer HAS_COLUMN relationships (outgoing)
    await neo4jService.executeQuery(`
      MATCH (dup:Table {id: $dupId})-[r:HAS_COLUMN]->(c:Column)
      MATCH (canon:Table {id: $canonId})
      WHERE NOT EXISTS((canon)-[:HAS_COLUMN]->(c))
      CREATE (canon)-[newR:HAS_COLUMN]->(c)
      SET newR = properties(r)
    `, { dupId, canonId });

    // Transfer HAS_TABLE relationships if any (incoming from schema/database nodes)
    await neo4jService.executeQuery(`
      MATCH (other)-[r:HAS_TABLE]->(dup:Table {id: $dupId})
      MATCH (canon:Table {id: $canonId})
      WHERE NOT EXISTS((other)-[:HAS_TABLE]->(canon))
      CREATE (other)-[newR:HAS_TABLE]->(canon)
      SET newR = properties(r)
    `, { dupId, canonId });

    // Transfer MAPS_TO relationships (outgoing)
    await neo4jService.executeQuery(`
      MATCH (dup:Table {id: $dupId})-[r:MAPS_TO]->(other)
      MATCH (canon:Table {id: $canonId})
      WHERE NOT EXISTS((canon)-[:MAPS_TO]->(other))
      CREATE (canon)-[newR:MAPS_TO]->(other)
      SET newR = properties(r)
    `, { dupId, canonId });

    // Transfer MAPS_TO relationships (incoming)
    await neo4jService.executeQuery(`
      MATCH (other)-[r:MAPS_TO]->(dup:Table {id: $dupId})
      MATCH (canon:Table {id: $canonId})
      WHERE NOT EXISTS((other)-[:MAPS_TO]->(canon))
      CREATE (other)-[newR:MAPS_TO]->(canon)
      SET newR = properties(r)
    `, { dupId, canonId });

    // Transfer ANNOTATED_WITH relationships (outgoing)
    await neo4jService.executeQuery(`
      MATCH (dup:Table {id: $dupId})-[r:ANNOTATED_WITH]->(other)
      MATCH (canon:Table {id: $canonId})
      WHERE NOT EXISTS((canon)-[:ANNOTATED_WITH]->(other))
      CREATE (canon)-[newR:ANNOTATED_WITH]->(other)
      SET newR = properties(r)
    `, { dupId, canonId });

    // Transfer ANNOTATED_WITH relationships (incoming)
    await neo4jService.executeQuery(`
      MATCH (other)-[r:ANNOTATED_WITH]->(dup:Table {id: $dupId})
      MATCH (canon:Table {id: $canonId})
      WHERE NOT EXISTS((other)-[:ANNOTATED_WITH]->(canon))
      CREATE (other)-[newR:ANNOTATED_WITH]->(canon)
      SET newR = properties(r)
    `, { dupId, canonId });

    // Transfer SIMILAR_TO relationships (outgoing)
    await neo4jService.executeQuery(`
      MATCH (dup:Table {id: $dupId})-[r:SIMILAR_TO]->(other)
      MATCH (canon:Table {id: $canonId})
      WHERE NOT EXISTS((canon)-[:SIMILAR_TO]->(other))
      CREATE (canon)-[newR:SIMILAR_TO]->(other)
      SET newR = properties(r)
    `, { dupId, canonId });

    // Transfer SIMILAR_TO relationships (incoming)
    await neo4jService.executeQuery(`
      MATCH (other)-[r:SIMILAR_TO]->(dup:Table {id: $dupId})
      MATCH (canon:Table {id: $canonId})
      WHERE NOT EXISTS((other)-[:SIMILAR_TO]->(canon))
      CREATE (other)-[newR:SIMILAR_TO]->(canon)
      SET newR = properties(r)
    `, { dupId, canonId });

    // Transfer RELATED_TO relationships (outgoing)
    await neo4jService.executeQuery(`
      MATCH (dup:Table {id: $dupId})-[r:RELATED_TO]->(other)
      MATCH (canon:Table {id: $canonId})
      WHERE NOT EXISTS((canon)-[:RELATED_TO]->(other))
      CREATE (canon)-[newR:RELATED_TO]->(other)
      SET newR = properties(r)
    `, { dupId, canonId });

    // Transfer RELATED_TO relationships (incoming)
    await neo4jService.executeQuery(`
      MATCH (other)-[r:RELATED_TO]->(dup:Table {id: $dupId})
      MATCH (canon:Table {id: $canonId})
      WHERE NOT EXISTS((other)-[:RELATED_TO]->(canon))
      CREATE (other)-[newR:RELATED_TO]->(canon)
      SET newR = properties(r)
    `, { dupId, canonId });

    // Merge properties (last-wins for description per spec)
    await neo4jService.executeQuery(`
      MATCH (dup:Table {id: $dupId})
      MATCH (canon:Table {id: $canonId})
      SET canon.description = coalesce(dup.description, canon.description),
      canon.rowCount = coalesce(canon.rowCount, dup.rowCount),
      canon.columnCount = coalesce(canon.columnCount, dup.columnCount)
    `, { dupId, canonId });

    // Delete duplicate
    await neo4jService.executeQuery(`
      MATCH (dup:Table {id: $dupId})
      DETACH DELETE dup
    `, { dupId });
  }

  /**
   * Deduplicate Column nodes with the same columnKey
   */
  private async deduplicateColumnNodes(): Promise<{ merged: number; details: string[] }> {
    const details: string[] = [];
    
    // Find duplicate groups
    const findDuplicatesQuery = `
      MATCH (c:Column)
      WHERE c.columnKey IS NOT NULL
      WITH c.columnKey AS key, collect(c) AS nodes
      WHERE size(nodes) > 1
      RETURN key, nodes
    `;

    const duplicatesResult = await neo4jService.executeQuery(findDuplicatesQuery);
    let totalMerged = 0;

    for (const record of duplicatesResult.records) {
      const key = record.get('key');
      const nodes = record.get('nodes');
      
      if (!nodes || nodes.length <= 1) continue;

      const canonicalNode = nodes[0];
      const duplicateNodes = nodes.slice(1);

      for (const duplicateNode of duplicateNodes) {
        try {
          await this.mergeDuplicateColumn(canonicalNode.properties.id, duplicateNode.properties.id);
          totalMerged++;
          
          const detail = `Merged duplicate column ${key}: ${duplicateNode.properties.id} -> ${canonicalNode.properties.id}`;
          details.push(detail);
          console.log(`  ${detail}`);
        } catch (error) {
          const errorDetail = `Failed to merge column duplicate for ${key}: ${error instanceof Error ? error.message : error}`;
          details.push(errorDetail);
          console.error(`  ${errorDetail}`);
        }
      }
    }

    return { merged: totalMerged, details };
  }

  /**
   * Helper method to properly merge duplicate column nodes
   */
  private async mergeDuplicateColumn(canonId: string, dupId: string): Promise<void> {
    // Transfer HAS_COLUMN relationships from tables (incoming)
    await neo4jService.executeQuery(`
      MATCH (t:Table)-[r:HAS_COLUMN]->(dup:Column {id: $dupId})
      MATCH (canon:Column {id: $canonId})
      WHERE NOT EXISTS((t)-[:HAS_COLUMN]->(canon))
      CREATE (t)-[newR:HAS_COLUMN]->(canon)
      SET newR = properties(r)
    `, { dupId, canonId });

    // Transfer HAS_VALUE relationships (outgoing)
    await neo4jService.executeQuery(`
      MATCH (dup:Column {id: $dupId})-[r:HAS_VALUE]->(v:Value)
      MATCH (canon:Column {id: $canonId})
      WHERE NOT EXISTS((canon)-[:HAS_VALUE]->(v))
      CREATE (canon)-[newR:HAS_VALUE]->(v)
      SET newR = properties(r)
    `, { dupId, canonId });

    // Transfer outgoing foreign key relationships
    await neo4jService.executeQuery(`
      MATCH (dup:Column {id: $dupId})-[r:FOREIGN_KEY_TO]->(other)
      MATCH (canon:Column {id: $canonId})
      WHERE NOT EXISTS((canon)-[:FOREIGN_KEY_TO]->(other))
      CREATE (canon)-[newR:FOREIGN_KEY_TO]->(other)
      SET newR = properties(r)
    `, { dupId, canonId });

    // Transfer incoming foreign key relationships
    await neo4jService.executeQuery(`
      MATCH (other)-[r:FOREIGN_KEY_TO]->(dup:Column {id: $dupId})
      MATCH (canon:Column {id: $canonId})
      WHERE NOT EXISTS((other)-[:FOREIGN_KEY_TO]->(canon))
      CREATE (other)-[newR:FOREIGN_KEY_TO]->(canon)
      SET newR = properties(r)
    `, { dupId, canonId });

    // Merge properties (last-wins for description per spec)
    await neo4jService.executeQuery(`
      MATCH (dup:Column {id: $dupId})
      MATCH (canon:Column {id: $canonId})
      SET canon.description = coalesce(dup.description, canon.description),
      canon.cardinality = coalesce(canon.cardinality, dup.cardinality),
      canon.nullPercentage = coalesce(canon.nullPercentage, dup.nullPercentage)
    `, { dupId, canonId });

    // Delete duplicate
    await neo4jService.executeQuery(`
      MATCH (dup:Column {id: $dupId})
      DETACH DELETE dup
    `, { dupId });
  }

  /**
   * Get statistics on duplicate nodes
   */
  async getDeduplicationStatistics(): Promise<{
    duplicateTableGroups: number;
    duplicateTables: number;
    duplicateColumnGroups: number;
    duplicateColumns: number;
  }> {
    let neo4jConnected = false;

    try {
      const neo4jConnectionId = environmentService.getNeo4jConnectionId();
      const neo4jConnection = await storage.getConnection(neo4jConnectionId);

      if (!neo4jConnection) {
        throw new Error('Neo4j connection not found');
      }

      neo4jConnected = await neo4jService.connect(neo4jConnection.config as any);

      if (!neo4jConnected) {
        throw new Error('Failed to connect to Neo4j');
      }

      // Count duplicate table groups
      const tableStatsQuery = `
        MATCH (t:Table)
        WHERE t.canonicalKey IS NOT NULL
        WITH t.canonicalKey AS key, count(t) AS cnt
        WHERE cnt > 1
        RETURN count(key) AS groups, sum(cnt - 1) AS duplicates
      `;

      const tableResult = await neo4jService.executeQuery(tableStatsQuery);
      const tableRecord = tableResult.records[0];

      // Count duplicate column groups
      const columnStatsQuery = `
        MATCH (c:Column)
        WHERE c.columnKey IS NOT NULL
        WITH c.columnKey AS key, count(c) AS cnt
        WHERE cnt > 1
        RETURN count(key) AS groups, sum(cnt - 1) AS duplicates
      `;

      const columnResult = await neo4jService.executeQuery(columnStatsQuery);
      const columnRecord = columnResult.records[0];

      return {
        duplicateTableGroups: tableRecord?.get('groups')?.toNumber() || 0,
        duplicateTables: tableRecord?.get('duplicates')?.toNumber() || 0,
        duplicateColumnGroups: columnRecord?.get('groups')?.toNumber() || 0,
        duplicateColumns: columnRecord?.get('duplicates')?.toNumber() || 0
      };
    } finally {
      if (neo4jConnected) {
        await neo4jService.disconnect();
      }
    }
  }
}

export const neo4jDeduplicationService = new Neo4jDeduplicationService();
