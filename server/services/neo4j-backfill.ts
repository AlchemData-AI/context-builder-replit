import { neo4jService } from './neo4j-service';
import { storage } from '../storage';
import { EnvironmentService } from './environment-service';

const environmentService = EnvironmentService.getInstance();

export interface BackfillResult {
  success: boolean;
  tablesUpdated: number;
  columnsUpdated: number;
  valuesUpdated: number;
  errors: string[];
}

export class Neo4jBackfillService {
  /**
   * Backfill canonical keys for existing Neo4j nodes
   * This adds canonicalKey/columnKey properties to nodes created before shared architecture
   */
  async backfillCanonicalKeys(): Promise<BackfillResult> {
    const result: BackfillResult = {
      success: true,
      tablesUpdated: 0,
      columnsUpdated: 0,
      valuesUpdated: 0,
      errors: []
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

      console.log('🔄 Starting canonical key backfill migration...');

      // Backfill Table nodes
      result.tablesUpdated = await this.backfillTableNodes();
      console.log(`✅ Updated ${result.tablesUpdated} Table nodes`);

      // Backfill Column nodes
      result.columnsUpdated = await this.backfillColumnNodes();
      console.log(`✅ Updated ${result.columnsUpdated} Column nodes`);

      // Backfill Value nodes (if needed in the future)
      result.valuesUpdated = 0; // Not implemented yet

      console.log(`✅ Backfill migration completed successfully`);
    } catch (error) {
      result.success = false;
      const errorMessage = error instanceof Error ? error.message : String(error);
      result.errors.push(errorMessage);
      console.error('❌ Backfill migration failed:', errorMessage);
    } finally {
      if (neo4jConnected) {
        await neo4jService.disconnect();
      }
    }

    return result;
  }

  /**
   * Backfill canonicalKey for Table nodes
   * Derives databaseId from AgentPersona namespace (format: database_<id>)
   */
  private async backfillTableNodes(): Promise<number> {
    const query = `
      MATCH (p:AgentPersona)-[:CONTAINS]->(t:Table)
      WHERE t.canonicalKey IS NULL
        AND p.namespace STARTS WITH 'database_'
        AND t.schema IS NOT NULL
        AND t.name IS NOT NULL
      WITH t, split(p.namespace, 'database_')[1] AS dbId
      WHERE dbId IS NOT NULL AND dbId <> ''
      SET t.canonicalKey = dbId + '.' + t.schema + '.' + t.name,
          t.databaseId = dbId
      RETURN count(DISTINCT t) AS updated
    `;

    const result = await neo4jService.executeQuery(query);
    return result.records[0]?.get('updated')?.toNumber() || 0;
  }

  /**
   * Backfill columnKey for Column nodes
   * Derives databaseId from AgentPersona namespace and table info from graph structure
   */
  private async backfillColumnNodes(): Promise<number> {
    const query = `
      MATCH (p:AgentPersona)-[:CONTAINS]->(t:Table)-[:HAS_COLUMN]->(c:Column)
      WHERE c.columnKey IS NULL
        AND p.namespace STARTS WITH 'database_'
        AND t.schema IS NOT NULL
        AND t.name IS NOT NULL
        AND c.name IS NOT NULL
      WITH c, t, split(p.namespace, 'database_')[1] AS dbId
      WHERE dbId IS NOT NULL AND dbId <> ''
      SET c.columnKey = dbId + '.' + t.schema + '.' + t.name + '.' + c.name,
          c.databaseId = dbId,
          c.tableSchema = t.schema,
          c.tableName = t.name
      RETURN count(DISTINCT c) AS updated
    `;

    const result = await neo4jService.executeQuery(query);
    return result.records[0]?.get('updated')?.toNumber() || 0;
  }

  /**
   * Get statistics on nodes missing canonical keys
   * Counts both total nodes and those eligible for backfill (connected to AgentPersona)
   */
  async getBackfillStatistics(): Promise<{
    tablesWithoutKeys: number;
    columnsWithoutKeys: number;
    tablesTotal: number;
    columnsTotal: number;
    tablesEligible: number;
    columnsEligible: number;
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

      // Get table statistics
      const tableStatsQuery = `
        MATCH (t:Table)
        WITH count(t) AS total,
             sum(CASE WHEN t.canonicalKey IS NULL THEN 1 ELSE 0 END) AS withoutKeys
        OPTIONAL MATCH (p:AgentPersona)-[:CONTAINS]->(t2:Table)
        WHERE t2.canonicalKey IS NULL
          AND p.namespace STARTS WITH 'database_'
          AND t2.schema IS NOT NULL
          AND t2.name IS NOT NULL
        RETURN total, withoutKeys, count(DISTINCT t2) AS eligible
      `;

      const tableResult = await neo4jService.executeQuery(tableStatsQuery);
      const tableRecord = tableResult.records[0];

      // Get column statistics
      const columnStatsQuery = `
        MATCH (c:Column)
        WITH count(c) AS total,
             sum(CASE WHEN c.columnKey IS NULL THEN 1 ELSE 0 END) AS withoutKeys
        OPTIONAL MATCH (p:AgentPersona)-[:CONTAINS]->(t:Table)-[:HAS_COLUMN]->(c2:Column)
        WHERE c2.columnKey IS NULL
          AND p.namespace STARTS WITH 'database_'
          AND t.schema IS NOT NULL
          AND t.name IS NOT NULL
          AND c2.name IS NOT NULL
        RETURN total, withoutKeys, count(DISTINCT c2) AS eligible
      `;

      const columnResult = await neo4jService.executeQuery(columnStatsQuery);
      const columnRecord = columnResult.records[0];

      return {
        tablesTotal: tableRecord?.get('total')?.toNumber() || 0,
        tablesWithoutKeys: tableRecord?.get('withoutKeys')?.toNumber() || 0,
        tablesEligible: tableRecord?.get('eligible')?.toNumber() || 0,
        columnsTotal: columnRecord?.get('total')?.toNumber() || 0,
        columnsWithoutKeys: columnRecord?.get('withoutKeys')?.toNumber() || 0,
        columnsEligible: columnRecord?.get('eligible')?.toNumber() || 0
      };
    } finally {
      if (neo4jConnected) {
        await neo4jService.disconnect();
      }
    }
  }
}

export const neo4jBackfillService = new Neo4jBackfillService();
