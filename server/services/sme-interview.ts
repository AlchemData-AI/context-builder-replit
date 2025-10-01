import { geminiService, type SMEQuestionSet } from './gemini';
import { schemaAnalyzer } from './schema-analyzer';
import { statisticalAnalyzer } from './statistical-analyzer';
import { postgresAnalyzer } from './postgres-analyzer';
import { storage } from '../storage';
import type { Table, Column, SmeQuestion } from '@shared/schema';

export interface SMEInterviewData {
  tableId: string;
  questions: SmeQuestion[];
  progress: {
    total: number;
    answered: number;
    percentage: number;
  };
}

export interface CSVExport {
  agentPersonaQuestions: Array<{
    persona: string;
    question: string;
    questionType: string;
    priority: string;
    options?: string;
    response?: string;
  }>;
  tableQuestions: Array<{
    table: string;
    question: string;
    questionType: string;
    priority: string;
    options?: string;
    response?: string;
  }>;
  columnQuestions: Array<{
    table: string;
    column: string;
    dataType: string;
    hypothesis: string;
    sampleValues: string;
    question: string;
    questionType: string;
    priority: string;
    options?: string;
    response?: string;
  }>;
  relationshipQuestions: Array<{
    fromTable: string;
    fromColumn: string;
    toTable: string;
    toColumn: string;
    question: string;
    questionType: string;
    priority: string;
    options?: string;
    response?: string;
  }>;
}

export class SMEInterviewService {
  async generateQuestionsForTable(tableId: string): Promise<SMEInterviewData> {
    const table = await storage.getTable(tableId);
    if (!table) {
      throw new Error('Table not found');
    }

    // Get sample data
    const sampleData = await schemaAnalyzer.getSampleData(tableId, 1000);
    
    // Get statistical analysis
    const statisticalResults = await statisticalAnalyzer.analyzeTable(tableId);
    
    // Get columns
    const columns = await storage.getColumnsByTableId(tableId);
    
    // Generate schema string
    const schema = this.generateSchemaString(table, columns);
    
    // Use Gemini to generate SME questions
    const questionSet = await geminiService.generateSMEQuestions(
      table.name,
      schema,
      sampleData,
      statisticalResults
    );

    // Store questions in database
    const questions: SmeQuestion[] = [];

    // Table-level question
    if (questionSet.table_hypothesis) {
      const tableQuestion = await storage.createSmeQuestion({
        tableId: table.id,
        questionType: 'table',
        questionText: `Table Hypothesis: ${questionSet.table_hypothesis}. Is this accurate?`,
        priority: 'high'
      });
      questions.push(tableQuestion);
    }

    // Column-level questions
    if (questionSet.columns) {
      for (const columnData of questionSet.columns) {
        const column = columns.find(c => c.name === columnData.column_name);
        if (!column) continue;

        // Skip timestamp/date columns - they don't need business logic clarification
        if (this.isTimestampColumn(column)) {
          continue;
        }

        // Skip high-cardinality columns (cardinality ratio >= 20%)
        // These are typically IDs or near-unique columns that don't need SME validation
        if (this.isHighCardinalityColumn(column, table)) {
          console.log(`⏭️  Skipping high-cardinality column: ${table.name}.${column.name} (cardinality: ${column.cardinality}, rowCount: ${table.rowCount}, ratio: ${column.cardinality && table.rowCount ? ((column.cardinality / table.rowCount) * 100).toFixed(2) : 'N/A'}%)`);
          continue;
        }

        // Store column hypothesis as AI description
        await storage.updateColumnStats(column.id, {
          aiDescription: columnData.hypothesis
        });

        // Create questions for this column
        for (const question of columnData.questions_for_user) {
          const smeQuestion = await storage.createSmeQuestion({
            tableId: table.id,
            columnId: column.id,
            questionType: 'column',
            questionText: question.question_text,
            options: question.options ? JSON.stringify(question.options) : null,
            priority: this.determinePriority(question, columnData)
          });
          questions.push(smeQuestion);
        }

        // Add enum values question for low cardinality columns
        if (columnData.enum_values_found && columnData.enum_values_found.length > 0) {
          const enumQuestion = await storage.createSmeQuestion({
            tableId: table.id,
            columnId: column.id,
            questionType: 'column',
            questionText: `We found these distinct values in ${columnData.column_name}: ${columnData.enum_values_found.join(', ')}. Please define what each value means.`,
            priority: 'high'
          });
          questions.push(enumQuestion);
        }
      }
    }

    return {
      tableId,
      questions,
      progress: {
        total: questions.length,
        answered: 0,
        percentage: 0
      }
    };
  }

  async generateAmbiguityQuestions(databaseId: string): Promise<SmeQuestion[]> {
    // Import semantic analyzer to avoid circular dependency
    const { semanticAnalyzer } = await import('./semantic-analyzer');
    
    const ambiguous = await semanticAnalyzer.findAmbiguousRelationships(databaseId);
    const questions: SmeQuestion[] = [];

    for (const ambiguity of ambiguous) {
      const conflictDetails = ambiguity.conflicts
        .map(c => `${c.targetTable}.${c.targetColumn} (confidence: ${(c.confidence * 100).toFixed(1)}%)`)
        .join(', ');

      const questionText = `We found multiple potential relationships for ${ambiguity.tableName}.${ambiguity.columnName}: ${conflictDetails}. Which relationship is correct, or are multiple relationships valid?`;

      const question = await storage.createSmeQuestion({
        questionType: 'ambiguity',
        questionText,
        options: JSON.stringify([
          ...ambiguity.conflicts.map(c => `${c.targetTable}.${c.targetColumn}`),
          'Multiple relationships are valid',
          'None of these relationships are correct'
        ]),
        priority: 'high'
      });
      
      questions.push(question);
    }

    return questions;
  }

  async getInterviewProgress(databaseId: string): Promise<{
    totalQuestions: number;
    answeredQuestions: number;
    percentage: number;
    byCategory: {
      table: { total: number; answered: number };
      column: { total: number; answered: number };
      relationship: { total: number; answered: number };
      ambiguity: { total: number; answered: number };
    };
  }> {
    const questions = await storage.getQuestionsByDatabaseId(databaseId);
    
    const totalQuestions = questions.length;
    const answeredQuestions = questions.filter(q => q.isAnswered).length;
    
    const byCategory = {
      table: {
        total: questions.filter(q => q.questionType === 'free_text_definitions').length,
        answered: questions.filter(q => q.questionType === 'free_text_definitions' && q.isAnswered).length
      },
      column: {
        total: questions.filter(q => q.questionType === 'multiple_choice').length,
        answered: questions.filter(q => q.questionType === 'multiple_choice' && q.isAnswered).length
      },
      relationship: {
        total: questions.filter(q => q.questionType === 'yes_no').length,
        answered: questions.filter(q => q.questionType === 'yes_no' && q.isAnswered).length
      },
      ambiguity: {
        total: 0, // Keep as placeholder for future use
        answered: 0
      }
    };

    return {
      totalQuestions,
      answeredQuestions,
      percentage: totalQuestions > 0 ? (answeredQuestions / totalQuestions) * 100 : 0,
      byCategory
    };
  }

  async exportToCSV(databaseId: string): Promise<CSVExport> {
    const questions = await storage.getQuestionsByDatabaseId(databaseId);
    const tables = await storage.getTablesByDatabaseId(databaseId);
    const personas = await storage.getPersonasByDatabaseId(databaseId);
    const contextItems = await storage.getContextsByDatabaseId(databaseId);

    // Get all columns for context and sample values (optimized - no database connection)
    const allColumns: Column[] = [];
    const columnSampleValues = new Map<string, string>(); // columnId -> sample values string
    
    for (const table of tables) {
      const columns = await storage.getColumnsByTableId(table.id);
      allColumns.push(...columns);
      
      // Use only existing distinct values from storage (faster)
      for (const column of columns) {
        let sampleValuesStr = 'No sample values available';
        if (column.distinctValues && typeof column.distinctValues === 'string') {
          try {
            const existingValues = JSON.parse(column.distinctValues);
            if (Array.isArray(existingValues) && existingValues.length > 0) {
              const filteredValues = existingValues
                .filter(val => val != null && val !== '')
                .slice(0, 5)
                .map(val => String(val).substring(0, 50));
              sampleValuesStr = filteredValues.length > 0 ? filteredValues.join(', ') : 'No distinct values found';
            }
          } catch (parseError) {
            // Keep default message
          }
        }
        columnSampleValues.set(column.id, sampleValuesStr);
      }
    }

    const export_data: CSVExport = {
      agentPersonaQuestions: [],
      tableQuestions: [],
      columnQuestions: [],
      relationshipQuestions: []
    };

    for (const question of questions) {
      const table = tables.find(t => t.id === question.tableId);
      const column = question.columnId ? allColumns.find(c => c.id === question.columnId) : null;

      const baseData = {
        question: question.questionText,
        questionType: question.questionType,
        priority: question.priority || 'medium',
        options: question.options ? JSON.stringify(question.options) : undefined,
        response: question.response || undefined
      };

      // Categorize questions based on whether they have a columnId
      if (!question.columnId) {
        // Table-level question
        export_data.tableQuestions.push({
          table: table?.name || 'Unknown',
          ...baseData
        });
      } else {
        // Column-level question
        const sampleValues = column ? columnSampleValues.get(column.id) || 'No sample values available' : 'No sample values available';
        export_data.columnQuestions.push({
          table: table?.name || 'Unknown',
          column: column?.name || 'Unknown',
          dataType: column?.dataType || 'Unknown',
          hypothesis: column?.aiDescription || '',
          sampleValues,
          ...baseData
        });
      }
    }

    // Add persona-level questions
    for (const persona of personas) {
      export_data.agentPersonaQuestions.push({
        persona: persona.name,
        question: `Please review and validate the Agent Persona definition: "${persona.description}". Are the assigned tables appropriate for this persona?`,
        questionType: 'free_text_definitions',
        priority: 'high'
      });
    }

    return export_data;
  }

  private generateSchemaString(table: Table, columns: Column[]): string {
    const columnDefs = columns.map(col => {
      let def = `  ${col.name} ${col.dataType}`;
      if (!col.isNullable) def += ' NOT NULL';
      if (col.isUnique) def += ' UNIQUE';
      return def;
    }).join(',\n');

    return `CREATE TABLE ${table.schema}.${table.name} (\n${columnDefs}\n);`;
  }

  private isTimestampColumn(column: Column): boolean {
    // Check data type (case-insensitive) - most reliable indicator
    const dataType = column.dataType.toLowerCase();
    const timestampTypes = [
      'timestamp',
      'timestamptz',
      'timestamp with time zone',
      'timestamp without time zone',
      'date',
      'time',
      'timetz',
      'time with time zone',
      'time without time zone',
      'interval'
    ];
    
    if (timestampTypes.some(type => dataType.includes(type))) {
      return true;
    }
    
    // Check explicit timestamp column names (conservative list to avoid false positives)
    const columnName = column.name.toLowerCase();
    const explicitTimestampNames = [
      'created_at',
      'updated_at',
      'deleted_at',
      'last_updated_at',
      'last_modified_at',
      'date_partition_delta',
      'timestamp'
    ];
    
    // Exact matches for known timestamp columns
    if (explicitTimestampNames.includes(columnName)) {
      return true;
    }
    
    // Check suffix pattern _at (e.g., logged_at, processed_at)
    // Only if data type suggests temporal nature to avoid false positives
    if (columnName.endsWith('_at')) {
      return true;
    }
    
    return false;
  }

  private isHighCardinalityColumn(column: Column, table: Table): boolean {
    // If cardinality or row count is not available, don't filter
    if (!column.cardinality || !table.rowCount) {
      console.log(`⚠️  Cannot calculate cardinality ratio for ${table.name}.${column.name} - cardinality: ${column.cardinality}, rowCount: ${table.rowCount}`);
      return false;
    }

    // Calculate cardinality ratio (distinct values / total rows)
    const cardinalityRatio = column.cardinality / table.rowCount;

    // Filter out columns with >= 20% cardinality ratio
    // These are typically IDs, order IDs, date partitions, or other near-unique columns
    const shouldFilter = cardinalityRatio >= 0.2;
    
    if (shouldFilter) {
      console.log(`🚫 High-cardinality filter: ${table.name}.${column.name} - ${(cardinalityRatio * 100).toFixed(2)}% (${column.cardinality}/${table.rowCount})`);
    }
    
    return shouldFilter;
  }

  private determinePriority(
    question: any, 
    columnData: any
  ): 'high' | 'medium' | 'low' {
    // High priority for enum values and ambiguity
    if (columnData.enum_values_found && columnData.enum_values_found.length > 0) {
      return 'high';
    }

    // High priority for ID columns
    if (columnData.column_name.includes('id')) {
      return 'high';
    }

    // High priority for null value questions
    if (question.question_text.toLowerCase().includes('null')) {
      return 'high';
    }

    // Medium priority for most questions
    return 'medium';
  }

  async processCSVResponse(csvData: string, databaseId: string): Promise<{processed: number, updated: number}> {
    // Parse CSV and update SME responses
    const lines = csvData.trim().split('\n').filter(line => line.trim());
    if (lines.length < 2) {
      throw new Error('Invalid CSV format: CSV must have at least a header row and one data row');
    }

    // Simple CSV parsing that handles quoted values
    const parseCSVLine = (line: string): string[] => {
      const result = [];
      let current = '';
      let inQuotes = false;
      
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          result.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      result.push(current.trim());
      return result;
    };

    // Check if this is a FOREIGN_KEY section (skip it for SME processing)
    const firstLine = parseCSVLine(lines[0]);
    const firstLineHeaders = firstLine.map(h => h.toLowerCase().replace(/['"]/g, '').trim());
    const isFKSection = firstLineHeaders[0] === 'section' && 
                       firstLineHeaders.some(h => h.includes('fk_id')) &&
                       firstLineHeaders.some(h => h.includes('validation_response'));
    
    if (isFKSection) {
      console.log('Detected FOREIGN_KEY section in CSV, skipping SME question processing for this section');
      // Return empty result - FK processor will handle this
      return { processed: 0, updated: 0 };
    }
    
    const headers = firstLineHeaders;
    
    // Look for question and response columns with more flexible matching
    const possibleQuestionHeaders = ['question', 'question_text', 'questiontext', 'prompt', 'query'];
    const possibleResponseHeaders = ['response', 'answer', 'reply', 'sme_response', 'smeresponse'];
    
    let questionIndex = -1;
    let responseIndex = -1;
    
    for (let i = 0; i < headers.length; i++) {
      const header = headers[i];
      if (questionIndex === -1 && possibleQuestionHeaders.some(ph => header.includes(ph))) {
        questionIndex = i;
      }
      if (responseIndex === -1 && possibleResponseHeaders.some(rh => header.includes(rh))) {
        responseIndex = i;
      }
    }
    
    if (questionIndex === -1 || responseIndex === -1) {
      throw new Error(`Invalid CSV format: Could not find question and response columns. Found headers: ${headers.join(', ')}`);
    }

    // Get all questions once for efficiency
    const questions = await storage.getQuestionsByDatabaseId(databaseId);
    let processed = 0;
    let updated = 0;

    for (let i = 1; i < lines.length; i++) {
      const row = parseCSVLine(lines[i]);
      if (row.length <= Math.max(questionIndex, responseIndex)) continue;

      const questionText = row[questionIndex]?.replace(/['"]/g, '').trim();
      const response = row[responseIndex]?.replace(/['"]/g, '').trim();

      if (!questionText || !response) continue;

      processed++;

      // Find matching question in database with improved matching
      const matchingQuestion = questions.find(q => {
        const qText = q.questionText.toLowerCase();
        const csvText = questionText.toLowerCase();
        return qText.includes(csvText) || csvText.includes(qText) || 
               qText.replace(/[^\w\s]/g, '') === csvText.replace(/[^\w\s]/g, '');
      });

      if (matchingQuestion) {
        await storage.answerSmeQuestion(matchingQuestion.id, response);
        updated++;
      }
    }

    console.log(`CSV processing complete: ${processed} rows processed, ${updated} questions updated`);
    return { processed, updated };
  }

  async processFKValidationsFromCSV(csvData: string, databaseId: string): Promise<{processed: number, validated: number, rejected: number, skipped: number}> {
    // Parse CSV and update FK validation status
    const lines = csvData.trim().split('\n'); // Don't filter blank lines - they separate sections
    
    // Reuse the same CSV parser from processCSVResponse for consistency
    const parseCSVLine = (line: string): string[] => {
      const result = [];
      let current = '';
      let inQuotes = false;
      
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        
        if (char === '"') {
          // Handle escaped quotes ("")
          if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
            current += '"';
            i++; // Skip the next quote
          } else {
            inQuotes = !inQuotes;
          }
        } else if (char === ',' && !inQuotes) {
          result.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      result.push(current.trim());
      return result;
    };

    let processed = 0;
    let validated = 0;
    let rejected = 0;
    let skipped = 0;
    let inFKSection = false;
    let fkIdIndex = -1;
    let validationResponseIndex = -1;
    let sectionIndex = -1;

    // Get all tables for this database once (for security validation)
    const tables = await storage.getTablesByDatabaseId(databaseId);
    const tableIds = new Set(tables.map(t => t.id));
    
    // Preload all FKs for this database once (performance optimization)
    const allFKs: any[] = [];
    for (const tableId of Array.from(tableIds)) {
      const tableFKs = await storage.getForeignKeysByTableId(tableId);
      allFKs.push(...tableFKs);
    }
    const fkMap = new Map(allFKs.map(fk => [fk.id, fk]));

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue; // Skip truly empty lines but don't remove them from parsing
      
      const row = parseCSVLine(line);
      
      // Detect FK section header: first column is "Section", contains FK_ID and Validation_Response
      if (row[0]?.toLowerCase().replace(/['"]/g, '').trim() === 'section' && 
          row.some(h => h.toLowerCase().replace(/['"]/g, '').includes('fk_id') || h.toLowerCase().replace(/['"]/g, '').includes('fk id')) &&
          row.some(h => h.toLowerCase().replace(/['"]/g, '').includes('validation_response') || h.toLowerCase().replace(/['"]/g, '').includes('validation response'))) {
        inFKSection = true;
        const headers = row.map(h => h.toLowerCase().replace(/['"]/g, '').trim());
        sectionIndex = headers.findIndex(h => h === 'section');
        fkIdIndex = headers.findIndex(h => h.includes('fk_id') || h.includes('fk id'));
        validationResponseIndex = headers.findIndex(h => h.includes('validation_response') || h.includes('validation response'));
        console.log(`Found FK section header at line ${i+1}: sectionIndex=${sectionIndex}, fkIdIndex=${fkIdIndex}, validationResponseIndex=${validationResponseIndex}`);
        continue;
      }
      
      // Skip if not in FK section or missing required column indices
      if (!inFKSection || fkIdIndex === -1 || validationResponseIndex === -1) continue;
      
      // Exit FK section if we hit a new section header
      if (row[sectionIndex]?.toLowerCase().replace(/['"]/g, '').trim() === 'section' && row.length > 1) {
        inFKSection = false;
        console.log(`Exiting FK section at line ${i+1}`);
        continue;
      }
      
      // Skip if not a FOREIGN_KEY data row
      const sectionValue = row[sectionIndex]?.replace(/['"]/g, '').trim().toUpperCase();
      if (sectionValue !== 'FOREIGN_KEY') continue;
      
      const fkId = row[fkIdIndex]?.replace(/['"]/g, '').trim();
      const validationResponse = row[validationResponseIndex]?.replace(/['"]/g, '').trim().toUpperCase();
      
      if (!fkId) continue;
      
      // Skip if validation response is empty or already validated
      if (!validationResponse || validationResponse === 'YES') continue;
      
      processed++;
      
      // SECURITY: Verify FK belongs to this database before modifying
      try {
        // Lookup FK in preloaded map (performance optimization)
        const targetFK = fkMap.get(fkId);
        if (!targetFK) {
          console.warn(`⚠️  Skipping FK ${fkId}: not found in database ${databaseId}`);
          skipped++;
          continue;
        }
        
        // Verify FK's tables belong to this database
        if (!tableIds.has(targetFK.fromTableId) && !tableIds.has(targetFK.toTableId)) {
          console.warn(`⚠️  Skipping FK ${fkId}: belongs to different database`);
          skipped++;
          continue;
        }
        
        // Process validation response
        if (['VALIDATED', 'YES', 'Y', 'APPROVE', 'APPROVED', 'TRUE', 'KEEP'].includes(validationResponse)) {
          await storage.updateForeignKeyValidation(fkId, true);
          validated++;
          console.log(`✅ FK ${fkId} marked as validated`);
        } else if (['REJECTED', 'NO', 'N', 'REJECT', 'DELETE', 'REMOVE', 'FALSE'].includes(validationResponse)) {
          await storage.deleteForeignKey(fkId);
          rejected++;
          console.log(`❌ FK ${fkId} deleted (rejected)`);
        }
      } catch (error) {
        console.error(`Failed to process FK ${fkId}:`, error);
        skipped++;
      }
    }

    console.log(`FK validation processing complete: ${processed} FKs processed, ${validated} validated, ${rejected} rejected, ${skipped} skipped`);
    return { processed, validated, rejected, skipped };
  }
}

export const smeInterviewService = new SMEInterviewService();
