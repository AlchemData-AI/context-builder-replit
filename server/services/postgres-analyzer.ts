import { Pool } from 'pg';

export interface PostgresConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean;
}

export interface TableInfo {
  tableName: string;
  schemaName: string;
  rowCount: number;
  columnCount: number;
  lastUpdated?: Date;
}

export interface ColumnInfo {
  columnName: string;
  dataType: string;
  isNullable: boolean;
  isUnique: boolean;
  defaultValue?: string;
  maxLength?: number;
}

export interface ForeignKeyInfo {
  constraintName: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

export class PostgresAnalyzer {
  private pool: Pool | null = null;
  private isDisconnecting: boolean = false;

  async connect(config: PostgresConfig): Promise<boolean> {
    try {
      // Auto-enable SSL for Azure PostgreSQL or if explicitly requested
      const shouldUseSSL = config.ssl !== false && (
        config.ssl === true ||
        config.host?.includes('azure.com') ||
        config.host?.includes('postgres.database')
      );

      const poolConfig = {
        ...config,
        ssl: shouldUseSSL ? { rejectUnauthorized: false } : undefined
      };

      this.pool = new Pool(poolConfig);
      this.isDisconnecting = false;

      // Test connection
      const client = await this.pool.connect();
      await client.query('SELECT 1');
      client.release();

      return true;
    } catch (error) {
      console.error('PostgreSQL connection failed:', error);
      return false;
    }
  }

  async disconnect(): Promise<void> {
    // Guard against multiple concurrent disconnect calls
    if (!this.pool || this.isDisconnecting) {
      return;
    }
    
    this.isDisconnecting = true;
    try {
      await this.pool.end();
    } catch (error) {
      // Ignore errors about pool already ended
      if (error instanceof Error && !error.message.includes('end on pool')) {
        throw error;
      }
    } finally {
      this.pool = null;
      this.isDisconnecting = false;
    }
  }

  async testConnection(): Promise<{ success: boolean; latency?: number; error?: string }> {
    if (!this.pool) {
      return { success: false, error: 'Not connected' };
    }

    const start = Date.now();
    try {
      const client = await this.pool.connect();
      await client.query('SELECT 1');
      client.release();
      
      const latency = Date.now() - start;
      return { success: true, latency };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async getSchemas(): Promise<string[]> {
    if (!this.pool) throw new Error('Not connected to database');

    const query = `
      SELECT schema_name 
      FROM information_schema.schemata 
      WHERE schema_name NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
      ORDER BY schema_name
    `;

    const result = await this.pool.query(query);
    return result.rows.map(row => row.schema_name);
  }

  async getTables(schemaName: string = 'public'): Promise<TableInfo[]> {
    if (!this.pool) throw new Error('Not connected to database');

    const query = `
      SELECT 
        t.table_name,
        t.table_schema as schema_name,
        COALESCE(s.n_tup_ins + s.n_tup_upd + s.n_tup_del, 0) as row_count,
        COUNT(c.column_name) as column_count
      FROM information_schema.tables t
      LEFT JOIN pg_stat_user_tables s ON s.relname = t.table_name
      LEFT JOIN information_schema.columns c ON c.table_name = t.table_name AND c.table_schema = t.table_schema
      WHERE t.table_schema = $1 AND t.table_type = 'BASE TABLE'
      GROUP BY t.table_name, t.table_schema, s.n_tup_ins, s.n_tup_upd, s.n_tup_del
      ORDER BY row_count DESC NULLS LAST
    `;

    const result = await this.pool.query(query, [schemaName]);
    
    return result.rows.map(row => ({
      tableName: row.table_name,
      schemaName: row.schema_name,
      rowCount: parseInt(row.row_count) || 0,
      columnCount: parseInt(row.column_count) || 0
    }));
  }

  async getTableRowCount(tableName: string, schemaName: string = 'public'): Promise<number> {
    if (!this.pool) throw new Error('Not connected to database');

    const query = `SELECT COUNT(*) as count FROM "${schemaName}"."${tableName}"`;
    const result = await this.pool.query(query);
    return parseInt(result.rows[0].count);
  }

  async getColumns(tableName: string, schemaName: string = 'public'): Promise<ColumnInfo[]> {
    if (!this.pool) throw new Error('Not connected to database');

    const query = `
      SELECT 
        c.column_name,
        c.data_type,
        c.is_nullable = 'YES' as is_nullable,
        c.column_default,
        c.character_maximum_length as max_length,
        CASE WHEN tc.constraint_type = 'UNIQUE' THEN true ELSE false END as is_unique
      FROM information_schema.columns c
      LEFT JOIN information_schema.key_column_usage kcu 
        ON c.table_name = kcu.table_name 
        AND c.column_name = kcu.column_name 
        AND c.table_schema = kcu.table_schema
      LEFT JOIN information_schema.table_constraints tc 
        ON kcu.constraint_name = tc.constraint_name 
        AND tc.constraint_type = 'UNIQUE'
      WHERE c.table_name = $1 AND c.table_schema = $2
      ORDER BY c.ordinal_position
    `;

    const result = await this.pool.query(query, [tableName, schemaName]);
    return result.rows.map(row => ({
      columnName: row.column_name,
      dataType: row.data_type,
      isNullable: row.is_nullable,
      isUnique: row.is_unique,
      defaultValue: row.column_default,
      maxLength: row.max_length
    }));
  }

  async getForeignKeys(schemaName: string = 'public'): Promise<ForeignKeyInfo[]> {
    if (!this.pool) throw new Error('Not connected to database');

    const query = `
      SELECT
        tc.constraint_name,
        tc.table_name as from_table,
        kcu.column_name as from_column,
        ccu.table_name as to_table,
        ccu.column_name as to_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu 
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu 
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' 
        AND tc.table_schema = $1
    `;

    const result = await this.pool.query(query, [schemaName]);
    return result.rows.map(row => ({
      constraintName: row.constraint_name,
      fromTable: row.from_table,
      fromColumn: row.from_column,
      toTable: row.to_table,
      toColumn: row.to_column
    }));
  }

  async getSampleData(
    tableName: string, 
    sampleSize: number = 1000, 
    schemaName: string = 'public'
  ): Promise<any[]> {
    if (!this.pool) throw new Error('Not connected to database');

    // Try to get recent data first, fall back to random sample
    const queries = [
      // Try with created_at, updated_at, or similar timestamp columns
      `SELECT * FROM "${schemaName}"."${tableName}" ORDER BY created_at DESC LIMIT $1`,
      `SELECT * FROM "${schemaName}"."${tableName}" ORDER BY updated_at DESC LIMIT $1`,
      `SELECT * FROM "${schemaName}"."${tableName}" ORDER BY timestamp DESC LIMIT $1`,
      // Fall back to random sample
      `SELECT * FROM "${schemaName}"."${tableName}" ORDER BY RANDOM() LIMIT $1`
    ];

    for (const query of queries) {
      try {
        const result = await this.pool.query(query, [sampleSize]);
        if (result.rows.length > 0) {
          return result.rows;
        }
      } catch (error) {
        // Continue to next query if this one fails
        continue;
      }
    }

    return [];
  }

  async getColumnCardinality(
    tableName: string, 
    columnName: string, 
    schemaName: string = 'public'
  ): Promise<number> {
    if (!this.pool) throw new Error('Not connected to database');

    const query = `SELECT COUNT(DISTINCT "${columnName}") as cardinality FROM "${schemaName}"."${tableName}"`;
    const result = await this.pool.query(query);
    return parseInt(result.rows[0].cardinality);
  }

  async getColumnNullPercentage(
    tableName: string, 
    columnName: string, 
    schemaName: string = 'public'
  ): Promise<number> {
    if (!this.pool) throw new Error('Not connected to database');

    const query = `
      SELECT 
        (COUNT(*) FILTER (WHERE "${columnName}" IS NULL) * 100.0 / COUNT(*)) as null_percentage
      FROM "${schemaName}"."${tableName}"
    `;
    
    const result = await this.pool.query(query);
    return parseFloat(result.rows[0].null_percentage) || 0;
  }

  async getColumnRange(
    tableName: string, 
    columnName: string, 
    schemaName: string = 'public'
  ): Promise<{ min: any; max: any }> {
    if (!this.pool) throw new Error('Not connected to database');

    const query = `
      SELECT 
        MIN("${columnName}") as min_value,
        MAX("${columnName}") as max_value
      FROM "${schemaName}"."${tableName}"
    `;
    
    const result = await this.pool.query(query);
    return {
      min: result.rows[0].min_value,
      max: result.rows[0].max_value
    };
  }

  async getDistinctValues(
    tableName: string, 
    columnName: string, 
    limit: number = 100,
    schemaName: string = 'public'
  ): Promise<any[]> {
    if (!this.pool) throw new Error('Not connected to database');

    const query = `
      SELECT DISTINCT "${columnName}" as value, COUNT(*) as frequency
      FROM "${schemaName}"."${tableName}"
      WHERE "${columnName}" IS NOT NULL
      GROUP BY "${columnName}"
      ORDER BY frequency DESC
      LIMIT $1
    `;
    
    const result = await this.pool.query(query, [limit]);
    return result.rows.map(row => row.value);
  }

  async analyzeValueOverlap(
    fromTable: string,
    fromColumn: string, 
    toTable: string,
    toColumn: string,
    schemaName: string = 'public'
  ): Promise<{ overlapPercentage: number; totalValues: number; matchingValues: number }> {
    if (!this.pool) throw new Error('Not connected to database');

    const query = `
      WITH 
      source_values AS (
        SELECT DISTINCT "${fromColumn}" as value FROM "${schemaName}"."${fromTable}" WHERE "${fromColumn}" IS NOT NULL
      ),
      target_values AS (
        SELECT DISTINCT "${toColumn}" as value FROM "${schemaName}"."${toTable}" WHERE "${toColumn}" IS NOT NULL
      ),
      intersection AS (
        SELECT value FROM source_values INTERSECT SELECT value FROM target_values
      )
      SELECT 
        (SELECT COUNT(*) FROM source_values) as total_values,
        (SELECT COUNT(*) FROM intersection) as matching_values,
        CASE 
          WHEN (SELECT COUNT(*) FROM source_values) = 0 THEN 0
          ELSE ((SELECT COUNT(*) FROM intersection) * 100.0 / (SELECT COUNT(*) FROM source_values))
        END as overlap_percentage
    `;

    const result = await this.pool.query(query);
    const row = result.rows[0];
    
    return {
      totalValues: parseInt(row.total_values),
      matchingValues: parseInt(row.matching_values),
      overlapPercentage: parseFloat(row.overlap_percentage)
    };
  }
}

export const postgresAnalyzer = new PostgresAnalyzer();
