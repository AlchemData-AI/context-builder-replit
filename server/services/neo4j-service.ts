import neo4j, { Driver, Session } from 'neo4j-driver';

export interface Neo4jConfig {
  uri: string;
  username: string;
  password: string;
  database?: string;
}

export interface AgentPersonaNode {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  namespace: string;
}

export interface TableNode {
  id: string;
  name: string;
  schema: string;
  description?: string;
  rowCount?: number;
  columnCount?: number;
}

export interface ColumnNode {
  id: string;
  name: string;
  dataType: string;
  description?: string;
  isNullable: boolean;
  cardinality?: number;
  nullPercentage?: number;
}

export interface ValueNode {
  id: string;
  value: string;
  frequency?: number;
}

export interface RelationshipInfo {
  fromId: string;
  toId: string;
  type: string;
  properties?: Record<string, any>;
}

export class Neo4jService {
  private driver: Driver | null = null;
  private database: string;

  constructor() {
    this.database = 'neo4j'; // default database
  }

  async connect(config: Neo4jConfig): Promise<boolean> {
    try {
      this.driver = neo4j.driver(
        config.uri,
        neo4j.auth.basic(config.username, config.password)
      );

      if (config.database) {
        this.database = config.database;
      }

      // Test connection
      const session = this.driver.session({ database: this.database });
      await session.run('RETURN 1');
      await session.close();

      return true;
    } catch (error) {
      console.error('Neo4j connection failed:', error);
      return false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
    }
  }

  async testConnection(): Promise<{ success: boolean; latency?: number; error?: string }> {
    if (!this.driver) {
      return { success: false, error: 'Not connected' };
    }

    const start = Date.now();
    try {
      const session = this.driver.session({ database: this.database });
      await session.run('RETURN 1');
      await session.close();
      
      const latency = Date.now() - start;
      return { success: true, latency };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private getSession(): Session {
    if (!this.driver) {
      throw new Error('Not connected to Neo4j');
    }
    return this.driver.session({ database: this.database });
  }

  async createNamespace(namespace: string): Promise<void> {
    const session = this.getSession();
    try {
      await session.run(
        'MERGE (n:Namespace {name: $namespace})',
        { namespace }
      );
    } finally {
      await session.close();
    }
  }

  async createAgentPersona(persona: AgentPersonaNode): Promise<void> {
    const session = this.getSession();
    try {
      await session.run(`
        MERGE (p:AgentPersona {id: $id, namespace: $namespace})
        SET p.name = $name,
            p.description = $description,
            p.keywords = $keywords,
            p.createdAt = datetime()
      `, {
        id: persona.id,
        name: persona.name,
        description: persona.description,
        keywords: persona.keywords,
        namespace: persona.namespace
      });
    } finally {
      await session.close();
    }
  }

  async createTableNode(personaId: string, table: TableNode): Promise<void> {
    const session = this.getSession();
    try {
      await session.run(`
        MATCH (p:AgentPersona {id: $personaId})
        MERGE (t:Table {id: $tableId})
        SET t.name = $name,
            t.schema = $schema,
            t.description = $description,
            t.rowCount = $rowCount,
            t.columnCount = $columnCount,
            t.createdAt = datetime()
        MERGE (p)-[:CONTAINS]->(t)
      `, {
        personaId,
        tableId: table.id,
        name: table.name,
        schema: table.schema,
        description: table.description,
        rowCount: table.rowCount,
        columnCount: table.columnCount
      });
    } finally {
      await session.close();
    }
  }

  async createColumnNode(tableId: string, column: ColumnNode): Promise<void> {
    const session = this.getSession();
    try {
      await session.run(`
        MATCH (t:Table {id: $tableId})
        MERGE (c:Column {id: $columnId})
        SET c.name = $name,
            c.dataType = $dataType,
            c.description = $description,
            c.isNullable = $isNullable,
            c.cardinality = $cardinality,
            c.nullPercentage = $nullPercentage,
            c.createdAt = datetime()
        MERGE (t)-[:HAS_COLUMN]->(c)
      `, {
        tableId,
        columnId: column.id,
        name: column.name,
        dataType: column.dataType,
        description: column.description,
        isNullable: column.isNullable,
        cardinality: column.cardinality,
        nullPercentage: column.nullPercentage
      });
    } finally {
      await session.close();
    }
  }

  async createValueNode(columnId: string, value: ValueNode): Promise<void> {
    const session = this.getSession();
    try {
      await session.run(`
        MATCH (c:Column {id: $columnId})
        MERGE (v:Value {id: $valueId})
        SET v.value = $value,
            v.frequency = $frequency,
            v.createdAt = datetime()
        MERGE (c)-[:HAS_VALUE]->(v)
      `, {
        columnId,
        valueId: value.id,
        value: value.value,
        frequency: value.frequency
      });
    } finally {
      await session.close();
    }
  }

  async createRelationship(relationship: RelationshipInfo): Promise<void> {
    const session = this.getSession();
    try {
      const { fromId, toId, type, properties = {} } = relationship;
      
      await session.run(`
        MATCH (from {id: $fromId})
        MATCH (to {id: $toId})
        MERGE (from)-[r:${type}]->(to)
        SET r += $properties,
            r.createdAt = datetime()
      `, {
        fromId,
        toId,
        properties
      });
    } finally {
      await session.close();
    }
  }

  async getGraphStatistics(namespace: string): Promise<{
    personaCount: number;
    tableCount: number;
    columnCount: number;
    valueCount: number;
    relationshipCount: number;
  }> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (p:AgentPersona {namespace: $namespace})
        OPTIONAL MATCH (p)-[:CONTAINS]->(t:Table)
        OPTIONAL MATCH (t)-[:HAS_COLUMN]->(c:Column)
        OPTIONAL MATCH (c)-[:HAS_VALUE]->(v:Value)
        OPTIONAL MATCH ()-[r]-()
        RETURN 
          COUNT(DISTINCT p) as personaCount,
          COUNT(DISTINCT t) as tableCount,
          COUNT(DISTINCT c) as columnCount,
          COUNT(DISTINCT v) as valueCount,
          COUNT(DISTINCT r) as relationshipCount
      `, { namespace });

      const stats = result.records[0];
      return {
        personaCount: stats.get('personaCount').toNumber(),
        tableCount: stats.get('tableCount').toNumber(),
        columnCount: stats.get('columnCount').toNumber(),
        valueCount: stats.get('valueCount').toNumber(),
        relationshipCount: stats.get('relationshipCount').toNumber()
      };
    } finally {
      await session.close();
    }
  }

  async getPersonaContext(personaId: string): Promise<any> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (p:AgentPersona {id: $personaId})
        OPTIONAL MATCH (p)-[:CONTAINS]->(t:Table)
        OPTIONAL MATCH (t)-[:HAS_COLUMN]->(c:Column)
        OPTIONAL MATCH (c)-[:HAS_VALUE]->(v:Value)
        RETURN p, 
               COLLECT(DISTINCT t) as tables,
               COLLECT(DISTINCT c) as columns,
               COLLECT(DISTINCT v) as values
      `, { personaId });

      if (result.records.length === 0) {
        return null;
      }

      const record = result.records[0];
      return {
        persona: record.get('p').properties,
        tables: record.get('tables').map((t: any) => t.properties),
        columns: record.get('columns').map((c: any) => c.properties),
        values: record.get('values').map((v: any) => v.properties)
      };
    } finally {
      await session.close();
    }
  }

  async searchByKeywords(keywords: string[], namespace: string): Promise<string[]> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (p:AgentPersona {namespace: $namespace})
        WHERE ANY(keyword IN $keywords WHERE keyword IN p.keywords)
        RETURN p.id as personaId
        ORDER BY SIZE([keyword IN $keywords WHERE keyword IN p.keywords]) DESC
      `, { keywords, namespace });

      return result.records.map(record => record.get('personaId'));
    } finally {
      await session.close();
    }
  }

  async clearNamespace(namespace: string): Promise<void> {
    const session = this.getSession();
    try {
      await session.run(`
        MATCH (n {namespace: $namespace})
        DETACH DELETE n
      `, { namespace });
    } finally {
      await session.close();
    }
  }

  async exportGraph(namespace: string): Promise<any> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (n {namespace: $namespace})
        OPTIONAL MATCH (n)-[r]-(m {namespace: $namespace})
        RETURN n, r, m
      `, { namespace });

      const nodes = new Map();
      const relationships = [];

      result.records.forEach(record => {
        const n = record.get('n');
        const r = record.get('r');
        const m = record.get('m');

        if (n) {
          nodes.set(n.identity.toString(), {
            id: n.identity.toString(),
            labels: n.labels,
            properties: n.properties
          });
        }

        if (m) {
          nodes.set(m.identity.toString(), {
            id: m.identity.toString(),
            labels: m.labels,
            properties: m.properties
          });
        }

        if (r) {
          relationships.push({
            id: r.identity.toString(),
            type: r.type,
            startNode: r.start.toString(),
            endNode: r.end.toString(),
            properties: r.properties
          });
        }
      });

      return {
        nodes: Array.from(nodes.values()),
        relationships
      };
    } finally {
      await session.close();
    }
  }
}

export const neo4jService = new Neo4jService();
