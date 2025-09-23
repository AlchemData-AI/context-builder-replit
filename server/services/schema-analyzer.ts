import { postgresAnalyzer, type TableInfo, type ColumnInfo, type ForeignKeyInfo } from './postgres-analyzer';
import { storage } from '../storage';
import type { Database, Table, Column } from '@shared/schema';

export interface SchemaAnalysisResult {
  totalTables: number;
  activeTables: number;
  totalColumns: number;
  foreignKeys: number;
  tables: TableInfo[];
}

export interface ColumnStatistics {
  cardinality: number;
  nullPercentage: number;
  minValue?: any;
  maxValue?: any;
  distinctValues?: any[];
}

export class SchemaAnalyzer {
  async analyzeDatabase(databaseId: string): Promise<SchemaAnalysisResult> {
    const database = await storage.getDatabase(databaseId);
    if (!database) {
      throw new Error('Database not found');
    }

    const connection = await storage.getConnection(database.connectionId);
    if (!connection) {
      throw new Error('Connection not found');
    }

    // Connect to PostgreSQL
    const config = connection.config as any;
    const connected = await postgresAnalyzer.connect(config);
    if (!connected) {
      throw new Error('Failed to connect to PostgreSQL');
    }

    try {
      // Get all tables
      const tables = await postgresAnalyzer.getTables(database.schema || 'public');
      
      // Get existing tables to avoid duplicates
      const existingTables = await storage.getTablesByDatabaseId(databaseId);
      const existingTableNames = new Set(existingTables.map(t => `${t.schema}.${t.name}`));

      // Store tables in database and populate their columns
      for (const tableInfo of tables) {
        const tableKey = `${tableInfo.schemaName}.${tableInfo.tableName}`;
        
        // Skip if table already exists
        if (existingTableNames.has(tableKey)) {
          console.log(`Skipping existing table: ${tableKey}`);
          continue;
        }

        const createdTable = await storage.createTable({
          databaseId,
          name: tableInfo.tableName,
          schema: tableInfo.schemaName,
          rowCount: tableInfo.rowCount,
          columnCount: tableInfo.columnCount,
          isSelected: false,
          sampleSize: this.calculateDefaultSampleSize(tableInfo.rowCount)
        });

        // Get and store column information for this table
        const columns = await postgresAnalyzer.getColumns(tableInfo.tableName, tableInfo.schemaName);
        
        for (const columnInfo of columns) {
          await storage.createColumn({
            tableId: createdTable.id,
            name: columnInfo.columnName,
            dataType: columnInfo.dataType,
            isNullable: columnInfo.isNullable,
            isUnique: columnInfo.isUnique,
            cardinality: null,
            nullPercentage: null,
            minValue: null,
            maxValue: null,
            distinctValues: null,
            aiDescription: null,
            smeValidated: false
          });
        }
      }

      // Get foreign keys
      const foreignKeys = await postgresAnalyzer.getForeignKeys(database.schema || 'public');

      // Store foreign key information
      for (const fk of foreignKeys) {
        const fromTables = await storage.getTablesByDatabaseId(databaseId);
        const toTables = await storage.getTablesByDatabaseId(databaseId);
        
        const fromTable = fromTables.find(t => t.name === fk.fromTable);
        const toTable = toTables.find(t => t.name === fk.toTable);
        
        if (fromTable && toTable) {
          const fromColumns = await storage.getColumnsByTableId(fromTable.id);
          const toColumns = await storage.getColumnsByTableId(toTable.id);
          
          const fromColumn = fromColumns.find(c => c.name === fk.fromColumn);
          const toColumn = toColumns.find(c => c.name === fk.toColumn);
          
          if (fromColumn && toColumn) {
            await storage.createForeignKey({
              fromTableId: fromTable.id,
              fromColumnId: fromColumn.id,
              toTableId: toTable.id,
              toColumnId: toColumn.id,
              confidence: "1.0",
              isValidated: true
            });
          }
        }
      }

      return {
        totalTables: tables.length,
        activeTables: tables.filter(t => t.rowCount > 0).length,
        totalColumns: tables.reduce((sum, t) => sum + t.columnCount, 0),
        foreignKeys: foreignKeys.length,
        tables
      };
    } finally {
      await postgresAnalyzer.disconnect();
    }
  }

  async analyzeTableColumns(tableId: string): Promise<void> {
    const table = await storage.getTable(tableId);
    if (!table) {
      throw new Error('Table not found');
    }

    const database = await storage.getDatabase(table.databaseId);
    if (!database) {
      throw new Error('Database not found');
    }

    const connection = await storage.getConnection(database.connectionId);
    if (!connection) {
      throw new Error('Connection not found');
    }

    // Connect to PostgreSQL
    const config = connection.config as any;
    const connected = await postgresAnalyzer.connect(config);
    if (!connected) {
      throw new Error('Failed to connect to PostgreSQL');
    }

    try {
      // Get column information
      const columns = await postgresAnalyzer.getColumns(table.name, table.schema);
      
      // Store columns in database
      for (const columnInfo of columns) {
        await storage.createColumn({
          tableId: table.id,
          name: columnInfo.columnName,
          dataType: columnInfo.dataType,
          isNullable: columnInfo.isNullable,
          isUnique: columnInfo.isUnique,
          cardinality: null,
          nullPercentage: null,
          minValue: null,
          maxValue: null,
          distinctValues: null,
          aiDescription: null,
          smeValidated: false
        });
      }
    } finally {
      await postgresAnalyzer.disconnect();
    }
  }

  async getColumnStatistics(columnId: string): Promise<ColumnStatistics> {
    const columns = await storage.getColumnsByTableId(''); // We need to get by column ID
    const column = columns.find(c => c.id === columnId);
    if (!column) {
      throw new Error('Column not found');
    }

    const table = await storage.getTable(column.tableId);
    if (!table) {
      throw new Error('Table not found');
    }

    const database = await storage.getDatabase(table.databaseId);
    if (!database) {
      throw new Error('Database not found');
    }

    const connection = await storage.getConnection(database.connectionId);
    if (!connection) {
      throw new Error('Connection not found');
    }

    // Connect to PostgreSQL
    const config = connection.config as any;
    const connected = await postgresAnalyzer.connect(config);
    if (!connected) {
      throw new Error('Failed to connect to PostgreSQL');
    }

    try {
      // Get column statistics
      const cardinality = await postgresAnalyzer.getColumnCardinality(
        table.name, 
        column.name, 
        table.schema
      );

      const nullPercentage = await postgresAnalyzer.getColumnNullPercentage(
        table.name, 
        column.name, 
        table.schema
      );

      let minValue, maxValue, distinctValues;

      // Get range for numeric columns
      if (['integer', 'bigint', 'decimal', 'numeric', 'real', 'double precision'].includes(column.dataType)) {
        const range = await postgresAnalyzer.getColumnRange(table.name, column.name, table.schema);
        minValue = range.min;
        maxValue = range.max;
      }

      // Get distinct values for low cardinality columns
      if (cardinality <= 100) {
        distinctValues = await postgresAnalyzer.getDistinctValues(
          table.name, 
          column.name, 
          100, 
          table.schema
        );
      }

      // Update column with statistics
      await storage.updateColumnStats(columnId, {
        cardinality,
        nullPercentage: nullPercentage.toString(),
        minValue: minValue?.toString(),
        maxValue: maxValue?.toString(),
        distinctValues: distinctValues ? JSON.stringify(distinctValues) : null
      });

      return {
        cardinality,
        nullPercentage,
        minValue,
        maxValue,
        distinctValues
      };
    } finally {
      await postgresAnalyzer.disconnect();
    }
  }

  private calculateDefaultSampleSize(rowCount: number): number {
    if (rowCount > 1000000) return 10000;
    if (rowCount > 100000) return 5000;
    if (rowCount > 10000) return 1000;
    return Math.min(rowCount, 1000);
  }

  async getSampleData(tableId: string, sampleSize?: number): Promise<any[]> {
    const table = await storage.getTable(tableId);
    if (!table) {
      throw new Error('Table not found');
    }

    const database = await storage.getDatabase(table.databaseId);
    if (!database) {
      throw new Error('Database not found');
    }

    const connection = await storage.getConnection(database.connectionId);
    if (!connection) {
      throw new Error('Connection not found');
    }

    // Connect to PostgreSQL
    const config = connection.config as any;
    const connected = await postgresAnalyzer.connect(config);
    if (!connected) {
      throw new Error('Failed to connect to PostgreSQL');
    }

    try {
      const effectiveSampleSize = sampleSize || table.sampleSize || 1000;
      return await postgresAnalyzer.getSampleData(
        table.name,
        effectiveSampleSize,
        table.schema
      );
    } finally {
      await postgresAnalyzer.disconnect();
    }
  }
}

export const schemaAnalyzer = new SchemaAnalyzer();
