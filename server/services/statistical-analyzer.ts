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
  sampleStrategy?: string;
  sampleSize?: number;
  sampleOffset?: number;
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
  async analyzeTable(
    tableId: string,
    sampleStrategy: 'top' | 'bottom' | 'random' = 'top',
    sampleOffset: number = 0,
    onProgress?: (progress: number) => void,
    manageConnection: boolean = true
  ): Promise<StatisticalAnalysisResult> {
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

    // Connect to PostgreSQL (only if managing connection)
    if (manageConnection) {
      const config = connection.config as any;
      const connected = await postgresAnalyzer.connect(config);
      if (!connected) {
        throw new Error('Failed to connect to PostgreSQL');
      }
    }

    try {
      const columns = await storage.getColumnsByTableId(tableId);
      const totalColumns = columns.length;
      let analyzedColumns = 0;

      // Fetch 1K sample rows once
      const sampleRows = await postgresAnalyzer.fetchSampleRows(
        table.name,
        table.schema,
        sampleStrategy,
        sampleOffset,
        table.sampleSize || 1000
      );

      if (sampleRows.length === 0) {
        throw new Error('No sample data available');
      }

      const lowCardinalityColumns: Column[] = [];
      const highNullColumns: Column[] = [];
      const numericColumns: Column[] = [];
      const categoricalColumns: Column[] = [];

      // Analyze each column using in-memory calculations
      for (const column of columns) {
        try {
          const analysis = this.calculateColumnStats(sampleRows, column.name, column.dataType);

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

      // Update table with sample metadata
      const samplesAnalyzed = (table.samplesAnalyzed || 0) + 1;
      const lastSampleStrategy = sampleStrategy === 'random'
        ? `random_${sampleOffset}`
        : sampleStrategy;

      await storage.updateTable(tableId, {
        samplesAnalyzed,
        lastSampleStrategy
      });

      return {
        tableId,
        tableName: table.name,
        totalColumns,
        analyzedColumns,
        lowCardinalityColumns,
        highNullColumns,
        numericColumns,
        categoricalColumns,
        progress: 100,
        sampleStrategy,
        sampleSize: table.sampleSize || 1000,
        sampleOffset: sampleStrategy === 'random' ? sampleOffset : undefined
      };
    } finally {
      // Only disconnect if we managed the connection
      if (manageConnection) {
        await postgresAnalyzer.disconnect();
      }
    }
  }

  private calculateColumnStats(
    sampleRows: any[],
    columnName: string,
    dataType: string
  ): {
    cardinality: number;
    nullPercentage: number;
    minValue?: any;
    maxValue?: any;
    distinctValues?: any[];
    patterns: string[];
    recommendations: string[];
  } {
    const values = sampleRows.map(row => row[columnName]);
    const nonNullValues = values.filter(v => v !== null && v !== undefined);

    // Calculate basic stats
    const totalRows = values.length;
    const nullCount = totalRows - nonNullValues.length;
    const nullPercentage = (nullCount / totalRows) * 100;
    const uniqueValues = new Set(nonNullValues);
    const cardinality = uniqueValues.size;

    let minValue: any = undefined;
    let maxValue: any = undefined;
    let distinctValues: any[] | undefined = undefined;
    const patterns: string[] = [];
    const recommendations: string[] = [];

    // Numeric analysis
    if (this.isNumericType(dataType) && nonNullValues.length > 0) {
      const numericValues = nonNullValues.map(v => Number(v)).filter(v => !isNaN(v));
      if (numericValues.length > 0) {
        minValue = Math.min(...numericValues);
        maxValue = Math.max(...numericValues);

        patterns.push(`Numeric range: ${minValue} to ${maxValue}`);

        if (minValue === maxValue) {
          patterns.push('Constant value');
          recommendations.push('Consider if this column is necessary');
        }
      }
    }

    // Categorical analysis
    if (cardinality <= 100) {
      distinctValues = Array.from(uniqueValues).slice(0, 100);

      if (cardinality <= 10) {
        patterns.push('Low cardinality - likely categorical');
        recommendations.push('Consider creating enum values for knowledge graph');
      } else if (cardinality <= 100) {
        patterns.push('Medium cardinality - potential categorical');
        recommendations.push('Review distinct values for categorization');
      }
    }

    // Null pattern analysis
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

    // Cardinality patterns
    if (cardinality === 1) {
      patterns.push('Single unique value');
      recommendations.push('Consider removing constant column');
    } else if (cardinality === totalRows) {
      patterns.push('All values unique');
      recommendations.push('Likely primary key or identifier');
    }

    // Text pattern analysis
    if (this.isTextType(dataType) && distinctValues && distinctValues.length > 0) {
      const stringValues = distinctValues.map(v => String(v));
      const avgLength = stringValues.reduce((sum, val) => sum + val.length, 0) / stringValues.length;

      if (avgLength < 10) {
        patterns.push('Short text values');
      } else if (avgLength > 100) {
        patterns.push('Long text content');
        recommendations.push('Consider if this should be analyzed differently');
      }

      // Check for patterns
      const hasEmailPattern = stringValues.some(val => val.includes('@'));
      const hasUrlPattern = stringValues.some(val => val.startsWith('http'));
      const hasPhonePattern = stringValues.some(val => /^\+?[\d\s\-\(\)]+$/.test(val));

      if (hasEmailPattern) patterns.push('Email addresses detected');
      if (hasUrlPattern) patterns.push('URLs detected');
      if (hasPhonePattern) patterns.push('Phone numbers detected');
    }

    return {
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
