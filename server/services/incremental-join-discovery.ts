import { storage } from '../storage';
import type { Table, Column } from '@shared/schema';

interface ForeignKeyConstraint {
  fromTableId: string;
  fromTableName: string;
  fromColumnId: string;
  fromColumnName: string;
  toTableId: string;
  toTableName: string;
  toColumnId: string;
  toColumnName: string;
  confidence: number;
  source: 'pg_catalog' | 'semantic' | 'heuristic';
  reasoning?: string;
}

interface JoinDiscoveryResult {
  discoveredFks: ForeignKeyConstraint[];
  persistedCount: number;
  smeQuestionsCount: number;
  skippedCount: number;
}

/**
 * Incremental Join Discovery Service
 * 
 * Discovers foreign key relationships between newly added tables and existing tables.
 * Uses a metadata-first approach: checks Postgres catalog first, then falls back to
 * semantic/heuristic analysis.
 */
export class IncrementalJoinDiscoveryService {
  
  /**
   * Discover joins incrementally for newly added tables
   * 
   * @param databaseId - The database ID
   * @param newTableIds - IDs of newly added tables to analyze
   * @returns Discovery results with counts
   */
  async discoverJoins(databaseId: string, newTableIds: string[]): Promise<JoinDiscoveryResult> {
    console.log(`🔍 Starting incremental join discovery for database ${databaseId}`);
    console.log(`📊 Analyzing ${newTableIds.length} new tables against existing tables`);
    
    const discoveredFks: ForeignKeyConstraint[] = [];
    
    // Get new tables and existing selected tables
    const newTables = await this.getTablesByIds(newTableIds);
    const allSelectedTables = await storage.getSelectedTables(databaseId);
    const existingTables = allSelectedTables.filter(t => !newTableIds.includes(t.id));
    
    console.log(`✓ Found ${newTables.length} new tables and ${existingTables.length} existing tables`);
    
    // Step 1: Extract actual FK constraints from Postgres metadata (fast, free, precise)
    console.log('📋 Step 1: Checking Postgres catalog for FK constraints...');
    const catalogFks = await this.extractPostgresFkConstraints(databaseId, newTableIds);
    discoveredFks.push(...catalogFks);
    console.log(`✓ Found ${catalogFks.length} FK constraints from Postgres catalog`);
    
    // Step 2: Run semantic analysis for new tables × existing tables (limited scope)
    console.log('🧠 Step 2: Running semantic analysis (new × existing tables)...');
    const semanticFks = await this.runIncrementalSemanticAnalysis(
      newTables,
      existingTables,
      discoveredFks // Pass catalog FKs to avoid duplicates
    );
    discoveredFks.push(...semanticFks);
    console.log(`✓ Found ${semanticFks.length} candidate FKs from semantic analysis`);
    
    // Step 3: Persist high-confidence FKs and generate SME questions for medium-confidence
    console.log('💾 Step 3: Persisting FKs and generating SME questions...');
    const { persistedCount, smeQuestionsCount, skippedCount } = await this.processFkCandidates(
      discoveredFks,
      databaseId
    );
    
    console.log(`✅ Incremental join discovery complete:`, {
      total: discoveredFks.length,
      persisted: persistedCount,
      smeQuestions: smeQuestionsCount,
      skipped: skippedCount
    });
    
    return {
      discoveredFks,
      persistedCount,
      smeQuestionsCount,
      skippedCount
    };
  }
  
  /**
   * Extract FK constraints from Postgres pg_catalog
   */
  private async extractPostgresFkConstraints(
    databaseId: string,
    tableIds: string[]
  ): Promise<ForeignKeyConstraint[]> {
    const fks: ForeignKeyConstraint[] = [];
    
    // Get database connection details
    const database = await storage.getDatabase(databaseId);
    if (!database) {
      console.warn('⚠️  Database not found, skipping catalog FK extraction');
      return fks;
    }
    
    const connection = await storage.getConnection(database.connectionId);
    if (!connection || connection.type !== 'postgresql') {
      console.warn('⚠️  PostgreSQL connection not found, skipping catalog FK extraction');
      return fks;
    }
    
    // Get table details
    const tables = await this.getTablesByIds(tableIds);
    const tableNameMap = new Map(tables.map(t => [t.name, t]));
    
    // Query pg_catalog for FK constraints
    // This will be implemented when we enhance the PostgreSQL analyzer
    // For now, return empty array and rely on semantic analysis
    console.log('ℹ️  Postgres catalog FK extraction pending (Task 2)');
    
    return fks;
  }
  
  /**
   * Run semantic analysis limited to new tables × existing tables
   */
  private async runIncrementalSemanticAnalysis(
    newTables: Table[],
    existingTables: Table[],
    existingFks: ForeignKeyConstraint[]
  ): Promise<ForeignKeyConstraint[]> {
    const candidates: ForeignKeyConstraint[] = [];
    
    if (newTables.length === 0 || existingTables.length === 0) {
      return candidates;
    }
    
    // Get columns for all tables
    const newTableColumns = new Map<string, Column[]>();
    const existingTableColumns = new Map<string, Column[]>();
    
    for (const table of newTables) {
      const columns = await storage.getColumnsByTableId(table.id);
      newTableColumns.set(table.id, columns);
    }
    
    for (const table of existingTables) {
      const columns = await storage.getColumnsByTableId(table.id);
      existingTableColumns.set(table.id, columns);
    }
    
    // Analyze new tables against existing tables ONLY (not new × new)
    for (const newTable of newTables) {
      const newCols = newTableColumns.get(newTable.id) || [];
      
      for (const existingTable of existingTables) {
        const existingCols = existingTableColumns.get(existingTable.id) || [];
        
        // Find FK candidates using heuristics
        const tableCandidates = this.findJoinCandidatesHeuristic(
          newTable,
          newCols,
          existingTable,
          existingCols,
          existingFks
        );
        
        candidates.push(...tableCandidates);
      }
    }
    
    // Note: Intra-persona joins (new × new) are handled by the standard
    // semantic analyzer when all tables are selected together
    
    return candidates;
  }
  
  /**
   * Find join candidates using heuristic analysis
   * (Adapted from semantic-analyzer.ts logic)
   */
  private findJoinCandidatesHeuristic(
    table1: Table,
    columns1: Column[],
    table2: Table,
    columns2: Column[],
    existingFks: ForeignKeyConstraint[]
  ): ForeignKeyConstraint[] {
    const candidates: ForeignKeyConstraint[] = [];
    
    // Check if this FK pair already exists
    const fkExists = (fromTableId: string, fromColId: string, toTableId: string, toColId: string) => {
      return existingFks.some(fk =>
        fk.fromTableId === fromTableId &&
        fk.fromColumnId === fromColId &&
        fk.toTableId === toTableId &&
        fk.toColumnId === toColId
      );
    };
    
    for (const col1 of columns1) {
      for (const col2 of columns2) {
        // Skip if FK already discovered
        if (fkExists(table1.id, col1.id, table2.id, col2.id)) {
          continue;
        }
        
        // Heuristic 1: Exact name match (high confidence)
        if (col1.name.toLowerCase() === col2.name.toLowerCase() &&
            col1.dataType === col2.dataType) {
          candidates.push({
            fromTableId: table1.id,
            fromTableName: table1.name,
            fromColumnId: col1.id,
            fromColumnName: col1.name,
            toTableId: table2.id,
            toTableName: table2.name,
            toColumnId: col2.id,
            toColumnName: col2.name,
            confidence: 0.85,
            source: 'heuristic',
            reasoning: 'Exact column name and type match'
          });
          continue;
        }
        
        // Heuristic 2: FK pattern match (table_id → table.id)
        const col1Lower = col1.name.toLowerCase();
        const col2Lower = col2.name.toLowerCase();
        const table2NameLower = table2.name.toLowerCase();
        
        // Check if col1 references table2's id column
        if ((col1Lower === `${table2NameLower}_id` || 
             col1Lower === `${table2NameLower}id`) &&
            (col2Lower === 'id' || col2Lower === `${table2NameLower}_id`)) {
          candidates.push({
            fromTableId: table1.id,
            fromTableName: table1.name,
            fromColumnId: col1.id,
            fromColumnName: col1.name,
            toTableId: table2.id,
            toTableName: table2.name,
            toColumnId: col2.id,
            toColumnName: col2.name,
            confidence: 0.80,
            source: 'heuristic',
            reasoning: `Column ${col1.name} follows FK naming pattern for ${table2.name}`
          });
          continue;
        }
        
        // Heuristic 3: Common suffixes (_id, _key, _code)
        if (col1Lower.endsWith('_id') || col1Lower.endsWith('_key') || col1Lower.endsWith('_code')) {
          const prefix = col1Lower.replace(/_(id|key|code)$/, '');
          if (table2NameLower.includes(prefix) || prefix.includes(table2NameLower)) {
            candidates.push({
              fromTableId: table1.id,
              fromTableName: table1.name,
              fromColumnId: col1.id,
              fromColumnName: col1.name,
              toTableId: table2.id,
              toTableName: table2.name,
              toColumnId: col2.id,
              toColumnName: col2.name,
              confidence: 0.65,
              source: 'heuristic',
              reasoning: `Column ${col1.name} may reference ${table2.name} (semantic similarity)`
            });
          }
        }
      }
    }
    
    return candidates;
  }
  
  /**
   * Process FK candidates: persist high-confidence, generate SME questions for medium-confidence
   */
  private async processFkCandidates(
    candidates: ForeignKeyConstraint[],
    databaseId: string
  ): Promise<{ persistedCount: number; smeQuestionsCount: number; skippedCount: number }> {
    let persistedCount = 0;
    let smeQuestionsCount = 0;
    let skippedCount = 0;
    
    for (const candidate of candidates) {
      try {
        // Check if this FK already exists in storage
        const existingFks = await storage.getForeignKeysByTableId(candidate.fromTableId);
        const alreadyExists = existingFks.some(fk =>
          fk.fromColumnId === candidate.fromColumnId &&
          fk.toColumnId === candidate.toColumnId
        );
        
        if (alreadyExists) {
          skippedCount++;
          continue;
        }
        
        // High confidence (≥0.8): Auto-persist
        if (candidate.confidence >= 0.8) {
          await storage.createForeignKey({
            fromTableId: candidate.fromTableId,
            fromColumnId: candidate.fromColumnId,
            toTableId: candidate.toTableId,
            toColumnId: candidate.toColumnId,
            confidence: candidate.confidence.toString(),
            isValidated: candidate.source === 'pg_catalog' // Catalog FKs are pre-validated
          });
          persistedCount++;
          console.log(`✓ Persisted high-confidence FK: ${candidate.fromTableName}.${candidate.fromColumnName} → ${candidate.toTableName}.${candidate.toColumnName} (${candidate.confidence})`);
        }
        // Medium confidence (0.6-0.8): Generate SME question
        else if (candidate.confidence >= 0.6) {
          await storage.createSmeQuestion({
            tableId: candidate.fromTableId,
            columnId: candidate.fromColumnId,
            questionType: 'relationship',
            questionText: `Does ${candidate.fromTableName}.${candidate.fromColumnName} reference ${candidate.toTableName}.${candidate.toColumnName}? ${candidate.reasoning || ''}`,
            options: {
              fromTableId: candidate.fromTableId,
              fromColumnId: candidate.fromColumnId,
              toTableId: candidate.toTableId,
              toColumnId: candidate.toColumnId,
              confidence: candidate.confidence,
              source: candidate.source
            },
            priority: 'medium'
          });
          smeQuestionsCount++;
          console.log(`❓ Created SME question for medium-confidence FK: ${candidate.fromTableName}.${candidate.fromColumnName} → ${candidate.toTableName}.${candidate.toColumnName} (${candidate.confidence})`);
        }
        // Low confidence (<0.6): Skip
        else {
          skippedCount++;
        }
      } catch (error) {
        console.error(`Failed to process FK candidate:`, error);
        skippedCount++;
      }
    }
    
    return { persistedCount, smeQuestionsCount, skippedCount };
  }
  
  /**
   * Helper: Get tables by IDs
   */
  private async getTablesByIds(tableIds: string[]): Promise<Table[]> {
    const tables: Table[] = [];
    for (const id of tableIds) {
      const table = await storage.getTable(id);
      if (table) {
        tables.push(table);
      }
    }
    return tables;
  }
}

// Export singleton instance
export const incrementalJoinDiscovery = new IncrementalJoinDiscoveryService();
