import { postgresAnalyzer } from './postgres-analyzer';
import { storage } from '../storage';
import type { Table, Column, ForeignKey } from '@shared/schema';

export interface SemanticJoinCandidate {
  fromTableId: string;
  fromTableName: string;
  fromColumnId: string;
  fromColumnName: string;
  toTableId: string;
  toTableName: string;
  toColumnId: string;
  toColumnName: string;
  confidence: number;
  overlapPercentage: number;
  similarity: number;
  reasoning: string;
  relationshipType: 'one-to-one' | 'one-to-many' | 'many-to-many';
}

export interface SimilarityMatch {
  table1: string;
  column1: string;
  table2: string;
  column2: string;
  similarity: number;
  matchType: 'exact' | 'semantic' | 'pattern';
}

export class SemanticAnalyzer {
  async analyzeJoinCandidates(databaseId: string): Promise<SemanticJoinCandidate[]> {
    const tables = await storage.getSelectedTables(databaseId);
    if (tables.length < 2) {
      return [];
    }

    const candidates: SemanticJoinCandidate[] = [];

    // Get all columns for selected tables
    const tableColumns = new Map<string, Column[]>();
    for (const table of tables) {
      const columns = await storage.getColumnsByTableId(table.id);
      tableColumns.set(table.id, columns);
    }

    // Compare all table pairs
    for (let i = 0; i < tables.length; i++) {
      for (let j = i + 1; j < tables.length; j++) {
        const table1 = tables[i];
        const table2 = tables[j];
        const columns1 = tableColumns.get(table1.id) || [];
        const columns2 = tableColumns.get(table2.id) || [];

        const tableCandidates = await this.findJoinCandidates(
          table1, columns1, table2, columns2
        );
        candidates.push(...tableCandidates);
      }
    }

    // Sort by confidence score
    candidates.sort((a, b) => b.confidence - a.confidence);

    // Store high-confidence candidates as foreign keys
    for (const candidate of candidates) {
      if (candidate.confidence >= 0.8) {
        await storage.createForeignKey({
          fromTableId: candidate.fromTableId,
          fromColumnId: candidate.fromColumnId,
          toTableId: candidate.toTableId,
          toColumnId: candidate.toColumnId,
          confidence: candidate.confidence.toString(),
          isValidated: false
        });
      }
    }

    return candidates;
  }

  private async findJoinCandidates(
    table1: Table, 
    columns1: Column[], 
    table2: Table, 
    columns2: Column[]
  ): Promise<SemanticJoinCandidate[]> {
    const candidates: SemanticJoinCandidate[] = [];

    const database = await storage.getDatabase(table1.databaseId);
    if (!database) return candidates;

    const connection = await storage.getConnection(database.connectionId);
    if (!connection) return candidates;

    // Connect to PostgreSQL
    const config = connection.config as any;
    const connected = await postgresAnalyzer.connect(config);
    if (!connected) return candidates;

    try {
      for (const col1 of columns1) {
        for (const col2 of columns2) {
          const similarity = this.calculateColumnSimilarity(
            table1.name, col1.name,
            table2.name, col2.name
          );

          // Skip if similarity is too low
          if (similarity < 0.5) continue;

          // Check data type compatibility
          if (!this.areTypesCompatible(col1.dataType, col2.dataType)) continue;

          // Analyze value overlap
          const overlap = await postgresAnalyzer.analyzeValueOverlap(
            table1.name, col1.name,
            table2.name, col2.name,
            table1.schema
          );

          // Calculate overall confidence
          const confidence = this.calculateJoinConfidence(
            similarity, 
            overlap.overlapPercentage,
            col1, 
            col2
          );

          if (confidence >= 0.6) {
            const relationshipType = this.determineRelationshipType(
              col1, col2, overlap
            );

            candidates.push({
              fromTableId: table1.id,
              fromTableName: table1.name,
              fromColumnId: col1.id,
              fromColumnName: col1.name,
              toTableId: table2.id,
              toTableName: table2.name,
              toColumnId: col2.id,
              toColumnName: col2.name,
              confidence,
              overlapPercentage: overlap.overlapPercentage,
              similarity,
              reasoning: this.generateReasoning(similarity, overlap, col1, col2),
              relationshipType
            });
          }
        }
      }
    } finally {
      await postgresAnalyzer.disconnect();
    }

    return candidates;
  }

  private calculateColumnSimilarity(
    table1: string, 
    column1: string, 
    table2: string, 
    column2: string
  ): number {
    // Exact match
    if (column1 === column2) {
      return 1.0;
    }

    // Common patterns
    const patterns = [
      // ID patterns
      { pattern: /^id$/i, weight: 0.9 },
      { pattern: /^(.+)_id$/i, weight: 0.85 },
      { pattern: /^(.+)id$/i, weight: 0.8 },
      
      // Foreign key patterns
      { pattern: new RegExp(`^${table2}_id$`, 'i'), weight: 0.95 },
      { pattern: new RegExp(`^${table1}_id$`, 'i'), weight: 0.95 },
      
      // User/Customer patterns
      { pattern: /^(user|customer|client)_?id$/i, weight: 0.9 },
      
      // Common business entities
      { pattern: /^(order|product|item|category)_?id$/i, weight: 0.85 }
    ];

    let maxSimilarity = 0;

    // Check if columns match any patterns
    for (const { pattern, weight } of patterns) {
      if (pattern.test(column1) && pattern.test(column2)) {
        maxSimilarity = Math.max(maxSimilarity, weight);
      }
    }

    // Fuzzy string matching
    const fuzzySimilarity = this.calculateFuzzySimilarity(column1, column2);
    maxSimilarity = Math.max(maxSimilarity, fuzzySimilarity);

    // Semantic similarity based on concatenated names
    const concat1 = `${table1}.${column1}`;
    const concat2 = `${table2}.${column2}`;
    const semanticSimilarity = this.calculateFuzzySimilarity(concat1, concat2);
    
    return Math.max(maxSimilarity, semanticSimilarity * 0.7);
  }

  private calculateFuzzySimilarity(str1: string, str2: string): number {
    // Levenshtein distance implementation
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    
    if (longer.length === 0) return 1.0;
    
    const editDistance = this.levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
  }

  private levenshteinDistance(str1: string, str2: string): number {
    const matrix = [];
    
    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }
    
    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }
    
    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    
    return matrix[str2.length][str1.length];
  }

  private areTypesCompatible(type1: string, type2: string): boolean {
    // Normalize types
    const normalizeType = (type: string) => {
      type = type.toLowerCase();
      if (type.includes('varchar') || type.includes('char')) return 'text';
      if (type.includes('int') || type.includes('serial')) return 'integer';
      if (type.includes('decimal') || type.includes('numeric')) return 'decimal';
      return type;
    };

    const norm1 = normalizeType(type1);
    const norm2 = normalizeType(type2);

    // Exact match
    if (norm1 === norm2) return true;

    // Compatible types
    const compatibleTypes = [
      ['integer', 'bigint'],
      ['text', 'varchar'],
      ['decimal', 'numeric', 'real']
    ];

    return compatibleTypes.some(group => 
      group.includes(norm1) && group.includes(norm2)
    );
  }

  private calculateJoinConfidence(
    similarity: number,
    overlapPercentage: number,
    col1: Column,
    col2: Column
  ): number {
    let confidence = 0;

    // Base similarity weight (40%)
    confidence += similarity * 0.4;

    // Overlap weight (30%)
    confidence += (overlapPercentage / 100) * 0.3;

    // Naming pattern bonuses (20%)
    if (col1.name.endsWith('_id') || col2.name.endsWith('_id')) {
      confidence += 0.1;
    }
    
    if (col1.name === 'id' || col2.name === 'id') {
      confidence += 0.1;
    }

    // Cardinality analysis (10%)
    if (col1.cardinality && col2.cardinality) {
      const cardinalityRatio = Math.min(col1.cardinality, col2.cardinality) / 
                               Math.max(col1.cardinality, col2.cardinality);
      confidence += cardinalityRatio * 0.1;
    }

    return Math.min(confidence, 1.0);
  }

  private determineRelationshipType(
    col1: Column,
    col2: Column,
    overlap: { totalValues: number; matchingValues: number }
  ): 'one-to-one' | 'one-to-many' | 'many-to-many' {
    if (!col1.cardinality || !col2.cardinality) {
      return 'one-to-many'; // Default assumption
    }

    const ratio = col1.cardinality / col2.cardinality;

    // If cardinalities are very similar, likely one-to-one
    if (ratio > 0.8 && ratio < 1.2) {
      return 'one-to-one';
    }

    // If one has much higher cardinality, it's likely one-to-many
    if (ratio > 2 || ratio < 0.5) {
      return 'one-to-many';
    }

    // Otherwise, assume many-to-many
    return 'many-to-many';
  }

  private generateReasoning(
    similarity: number,
    overlap: { overlapPercentage: number; totalValues: number; matchingValues: number },
    col1: Column,
    col2: Column
  ): string {
    const reasons: string[] = [];

    if (similarity >= 0.9) {
      reasons.push('Very high name similarity');
    } else if (similarity >= 0.7) {
      reasons.push('High name similarity');
    }

    if (overlap.overlapPercentage >= 80) {
      reasons.push(`${overlap.overlapPercentage.toFixed(1)}% value overlap`);
    } else if (overlap.overlapPercentage >= 50) {
      reasons.push(`Moderate value overlap (${overlap.overlapPercentage.toFixed(1)}%)`);
    }

    if (col1.name.endsWith('_id') || col2.name.endsWith('_id')) {
      reasons.push('Foreign key naming pattern');
    }

    if (col1.name === 'id' || col2.name === 'id') {
      reasons.push('Primary key relationship');
    }

    return reasons.join(', ');
  }

  async findAmbiguousRelationships(databaseId: string): Promise<{
    columnId: string;
    tableName: string;
    columnName: string;
    conflicts: Array<{
      targetTable: string;
      targetColumn: string;
      confidence: number;
    }>;
  }[]> {
    const foreignKeys = await storage.getForeignKeysByTableId(databaseId);
    const ambiguous: any[] = [];

    // Group foreign keys by source column
    const columnGroups = new Map<string, ForeignKey[]>();
    for (const fk of foreignKeys) {
      if (!columnGroups.has(fk.fromColumnId)) {
        columnGroups.set(fk.fromColumnId, []);
      }
      columnGroups.get(fk.fromColumnId)!.push(fk);
    }

    // Find columns with multiple potential relationships
    for (const [columnId, relationships] of columnGroups) {
      if (relationships.length > 1) {
        // Get column and table information
        const tables = await storage.getTablesByDatabaseId(databaseId);
        const allColumns: Column[] = [];
        
        for (const table of tables) {
          const cols = await storage.getColumnsByTableId(table.id);
          allColumns.push(...cols);
        }

        const column = allColumns.find(c => c.id === columnId);
        const table = tables.find(t => relationships[0].fromTableId === t.id);

        if (column && table) {
          const conflicts = await Promise.all(
            relationships.map(async (rel) => {
              const targetTable = tables.find(t => t.id === rel.toTableId);
              const targetColumn = allColumns.find(c => c.id === rel.toColumnId);
              
              return {
                targetTable: targetTable?.name || 'Unknown',
                targetColumn: targetColumn?.name || 'Unknown',
                confidence: parseFloat(rel.confidence || '0')
              };
            })
          );

          ambiguous.push({
            columnId,
            tableName: table.name,
            columnName: column.name,
            conflicts
          });
        }
      }
    }

    return ambiguous;
  }
}

export const semanticAnalyzer = new SemanticAnalyzer();
