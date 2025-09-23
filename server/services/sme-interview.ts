import { geminiService, type SMEQuestionSet } from './gemini';
import { schemaAnalyzer } from './schema-analyzer';
import { statisticalAnalyzer } from './statistical-analyzer';
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
        total: questions.filter(q => q.questionType === 'table').length,
        answered: questions.filter(q => q.questionType === 'table' && q.isAnswered).length
      },
      column: {
        total: questions.filter(q => q.questionType === 'column').length,
        answered: questions.filter(q => q.questionType === 'column' && q.isAnswered).length
      },
      relationship: {
        total: questions.filter(q => q.questionType === 'relationship').length,
        answered: questions.filter(q => q.questionType === 'relationship' && q.isAnswered).length
      },
      ambiguity: {
        total: questions.filter(q => q.questionType === 'ambiguity').length,
        answered: questions.filter(q => q.questionType === 'ambiguity' && q.isAnswered).length
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

    // Get all columns for context
    const allColumns: Column[] = [];
    for (const table of tables) {
      const columns = await storage.getColumnsByTableId(table.id);
      allColumns.push(...columns);
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
        export_data.columnQuestions.push({
          table: table?.name || 'Unknown',
          column: column?.name || 'Unknown',
          dataType: column?.dataType || 'Unknown',
          hypothesis: column?.aiDescription || '',
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

  async processCSVResponse(csvData: string, databaseId: string): Promise<void> {
    // Parse CSV and update SME responses
    const lines = csvData.split('\n');
    const headers = lines[0].split(',');
    
    const questionIndex = headers.findIndex(h => h.toLowerCase().includes('question'));
    const responseIndex = headers.findIndex(h => h.toLowerCase().includes('response'));
    
    if (questionIndex === -1 || responseIndex === -1) {
      throw new Error('Invalid CSV format: missing question or response columns');
    }

    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(',');
      if (row.length < Math.max(questionIndex, responseIndex) + 1) continue;

      const questionText = row[questionIndex]?.trim();
      const response = row[responseIndex]?.trim();

      if (!questionText || !response) continue;

      // Find matching question in database
      const questions = await storage.getQuestionsByDatabaseId(databaseId);
      const matchingQuestion = questions.find(q => 
        q.questionText.includes(questionText) || questionText.includes(q.questionText)
      );

      if (matchingQuestion) {
        await storage.answerSmeQuestion(matchingQuestion.id, response);
      }
    }
  }
}

export const smeInterviewService = new SMEInterviewService();
