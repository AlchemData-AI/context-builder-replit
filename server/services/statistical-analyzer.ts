import { postgresAnalyzer } from './postgres-analyzer';
import { storage } from '../storage';
import type { Table, Column } from '@shared/schema';

export interface StatisticalAnalysisResult {
  tableId: string;
  tableName: string;
  totalColumns: number;
  analyzedColumns: number;
  lowCardinalityColumns: Column[];
  highNullColumns: Column[];
  numericColumns: Column[];
  categoricalColumns: Column[];
  progress: number;
}

export interface ColumnAnalysis {
  columnId: string;
  columnName: string;
  dataType: string;
  cardinality: number;
  nullPercentage: number;
  minValue?: any;
  maxValue?: any;
  distinctValues?: any[];
  patterns: string[];
  recommendations: string[];
}

export class StatisticalAnalyzer {
  async analyzeTable(tableId: string, onProgress?: (progress: number) => void): Promise<StatisticalAnalysisResult> {
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
      const columns = await storage.getColumnsByTableId(tableId);
      const totalColumns = columns.length;
      let analyzedColumns = 0;

      const lowCardinalityColumns: Column[] = [];
      const highNullColumns: Column[] = [];
      const numericColumns: Column[] = [];
      const categoricalColumns: Column[] = [];

      for (const column of columns) {
        try {
          const analysis = await this.analyzeColumn(table, column);
          
          // Update column with analysis results
          await storage.updateColumnStats(column.id, {
            cardinality: analysis.cardinality,
            nullPercentage: analysis.nullPercentage.toString(),
            minValue: analysis.minValue?.toString(),
            maxValue: analysis.maxValue?.toString(),
            distinctValues: analysis.distinctValues ? JSON.stringify(analysis.distinctValues) : null
          });

          // Categorize columns
          if (analysis.cardinality <= 100) {
            lowCardinalityColumns.push({
              ...column,
              cardinality: analysis.cardinality,
              nullPercentage: analysis.nullPercentage.toString(),
              distinctValues: analysis.distinctValues ? JSON.stringify(analysis.distinctValues) : null
            });
          }

          if (analysis.nullPercentage > 40) {
            highNullColumns.push({
              ...column,
              cardinality: analysis.cardinality,
              nullPercentage: analysis.nullPercentage.toString()
            });
          }

          if (this.isNumericType(column.dataType)) {
            numericColumns.push({
              ...column,
              cardinality: analysis.cardinality,
              minValue: analysis.minValue?.toString(),
              maxValue: analysis.maxValue?.toString()
            });
          }

          if (this.isCategoricalType(column.dataType) && analysis.cardinality <= 100) {
            categoricalColumns.push({
              ...column,
              cardinality: analysis.cardinality,
              distinctValues: analysis.distinctValues ? JSON.stringify(analysis.distinctValues) : null
            });
          }

          analyzedColumns++;
          const progress = Math.round((analyzedColumns / totalColumns) * 100);
          if (onProgress) {
            onProgress(progress);
          }
        } catch (error) {
          console.error(`Failed to analyze column ${column.name}:`, error);
        }
      }

      return {
        tableId,
        tableName: table.name,
        totalColumns,
        analyzedColumns,
        lowCardinalityColumns,
        highNullColumns,
        numericColumns,
        categoricalColumns,
        progress: 100
      };
    } finally {
      await postgresAnalyzer.disconnect();
    }
  }

  private async analyzeColumn(table: Table, column: Column): Promise<ColumnAnalysis> {
    // Get cardinality
    const cardinality = await postgresAnalyzer.getColumnCardinality(
      table.name, 
      column.name, 
      table.schema
    );

    // Get null percentage
    const nullPercentage = await postgresAnalyzer.getColumnNullPercentage(
      table.name, 
      column.name, 
      table.schema
    );

    let minValue, maxValue, distinctValues;
    const patterns: string[] = [];
    const recommendations: string[] = [];

    // Analyze numeric columns
    if (this.isNumericType(column.dataType)) {
      const range = await postgresAnalyzer.getColumnRange(table.name, column.name, table.schema);
      minValue = range.min;
      maxValue = range.max;
      
      patterns.push(`Numeric range: ${minValue} to ${maxValue}`);
      
      if (minValue !== null && maxValue !== null) {
        const rangeSize = maxValue - minValue;
        if (rangeSize === 0) {
          patterns.push('Constant value');
          recommendations.push('Consider if this column is necessary');
        } else if (cardinality / rangeSize < 0.1) {
          patterns.push('Sparse numeric distribution');
        }
      }
    }

    // Analyze categorical columns
    if (cardinality <= 100) {
      distinctValues = await postgresAnalyzer.getDistinctValues(
        table.name, 
        column.name, 
        100, 
        table.schema
      );
      
      if (cardinality <= 10) {
        patterns.push('Low cardinality - likely categorical');
        recommendations.push('Consider creating enum values for knowledge graph');
      } else if (cardinality <= 100) {
        patterns.push('Medium cardinality - potential categorical');
        recommendations.push('Review distinct values for categorization');
      }
    }

    // Analyze null patterns
    if (nullPercentage > 80) {
      patterns.push('Very high null percentage');
      recommendations.push('Investigate why most values are null');
    } else if (nullPercentage > 50) {
      patterns.push('High null percentage');
      recommendations.push('Consider nullable business logic');
    } else if (nullPercentage === 0) {
      patterns.push('No null values');
      recommendations.push('Potentially required field');
    }

    // Analyze cardinality patterns
    if (cardinality === 1) {
      patterns.push('Single unique value');
      recommendations.push('Consider removing constant column');
    } else if (cardinality === (table.rowCount || 0)) {
      patterns.push('All values unique');
      recommendations.push('Likely primary key or identifier');
    }

    // Text pattern analysis
    if (this.isTextType(column.dataType) && distinctValues) {
      const avgLength = distinctValues.reduce((sum, val) => sum + String(val).length, 0) / distinctValues.length;
      
      if (avgLength < 10) {
        patterns.push('Short text values');
      } else if (avgLength > 100) {
        patterns.push('Long text content');
        recommendations.push('Consider if this should be analyzed differently');
      }

      // Check for patterns in text
      const hasEmailPattern = distinctValues.some(val => String(val).includes('@'));
      const hasUrlPattern = distinctValues.some(val => String(val).startsWith('http'));
      const hasPhonePattern = distinctValues.some(val => /^\+?[\d\s\-\(\)]+$/.test(String(val)));
      
      if (hasEmailPattern) patterns.push('Email addresses detected');
      if (hasUrlPattern) patterns.push('URLs detected');
      if (hasPhonePattern) patterns.push('Phone numbers detected');
    }

    return {
      columnId: column.id,
      columnName: column.name,
      dataType: column.dataType,
      cardinality,
      nullPercentage,
      minValue,
      maxValue,
      distinctValues,
      patterns,
      recommendations
    };
  }

  private isNumericType(dataType: string): boolean {
    const numericTypes = [
      'integer', 'bigint', 'smallint', 'decimal', 'numeric', 
      'real', 'double precision', 'serial', 'bigserial'
    ];
    return numericTypes.includes(dataType.toLowerCase());
  }

  private isCategoricalType(dataType: string): boolean {
    const categoricalTypes = [
      'character varying', 'varchar', 'char', 'text', 'enum'
    ];
    return categoricalTypes.some(type => dataType.toLowerCase().includes(type));
  }

  private isTextType(dataType: string): boolean {
    const textTypes = [
      'character varying', 'varchar', 'char', 'text'
    ];
    return textTypes.some(type => dataType.toLowerCase().includes(type));
  }

  async generateStatisticalSummary(databaseId: string): Promise<{
    totalTables: number;
    analyzedTables: number;
    totalColumns: number;
    analyzedColumns: number;
    lowCardinalityColumns: number;
    highNullColumns: number;
    potentialJoinColumns: number;
    patterns: string[];
  }> {
    const tables = await storage.getTablesByDatabaseId(databaseId);
    const analyzedTables = tables.filter(t => t.isSelected);
    
    let totalColumns = 0;
    let analyzedColumns = 0;
    let lowCardinalityColumns = 0;
    let highNullColumns = 0;
    let potentialJoinColumns = 0;
    const patterns: string[] = [];

    for (const table of analyzedTables) {
      const columns = await storage.getColumnsByTableId(table.id);
      totalColumns += columns.length;
      
      for (const column of columns) {
        if (column.cardinality !== null) {
          analyzedColumns++;
          
          if (column.cardinality <= 100) {
            lowCardinalityColumns++;
          }
          
          const nullPercentage = parseFloat(column.nullPercentage || '0');
          if (nullPercentage > 40) {
            highNullColumns++;
          }
          
          // Check for potential join columns (ending with _id, id, etc.)
          if (column.name.endsWith('_id') || column.name === 'id') {
            potentialJoinColumns++;
          }
        }
      }
    }

    // Generate summary patterns
    if (lowCardinalityColumns > 0) {
      patterns.push(`${lowCardinalityColumns} low-cardinality columns found (good for enum values)`);
    }
    
    if (highNullColumns > 0) {
      patterns.push(`${highNullColumns} columns with high null percentages (>40%)`);
    }
    
    if (potentialJoinColumns > 0) {
      patterns.push(`${potentialJoinColumns} potential join columns identified`);
    }

    const completionRate = totalColumns > 0 ? (analyzedColumns / totalColumns) * 100 : 0;
    patterns.push(`Statistical analysis ${completionRate.toFixed(1)}% complete`);

    return {
      totalTables: tables.length,
      analyzedTables: analyzedTables.length,
      totalColumns,
      analyzedColumns,
      lowCardinalityColumns,
      highNullColumns,
      potentialJoinColumns,
      patterns
    };
  }
}

export const statisticalAnalyzer = new StatisticalAnalyzer();
