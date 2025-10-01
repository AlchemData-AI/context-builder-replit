import { GoogleGenAI } from "@google/genai";
import { neo4jService } from "./neo4j-service";

const ai = new GoogleGenAI({ 
  apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "" 
});

export interface TableDescription {
  table_name: string;
  description: string;
  business_purpose: string;
  data_characteristics: string;
}

export interface ColumnDescription {
  column_name: string;
  description: string;
  business_meaning: string;
  data_patterns: string;
  enum_values?: string[];
}

export interface JoinSuggestion {
  from_table: string;
  from_column: string;
  to_table: string;
  to_column: string;
  confidence: number;
  reasoning: string;
  relationship_type: string;
}

export interface SMEQuestion {
  question_text: string;
  question_type: "yes_no" | "multiple_choice" | "free_text_definitions";
  options?: string[];
  priority: "high" | "medium" | "low";
}

export interface SMEQuestionSet {
  table_name?: string;
  column_name?: string;
  sampling_info: string;
  table_hypothesis?: string;
  columns?: Array<{
    column_name: string;
    data_type: string;
    sample_values: string[];
    enum_values_found?: string[];
    hypothesis: string;
    questions_for_user: SMEQuestion[];
  }>;
}

export class GeminiService {
  private truncateText(text: string, maxTokens: number = 6000): string {
    // Rough estimation: 1 token ≈ 4 characters
    const maxChars = maxTokens * 4;
    if (text.length <= maxChars) return text;
    
    return text.substring(0, maxChars) + "...[truncated]";
  }

  /**
   * Generate or reuse table description with context awareness
   * Checks Neo4j for existing context before calling LLM (cost savings)
   */
  async generateOrReuseTableDescription(
    tableName: string,
    schema: string,
    sampleData: any[],
    databaseId: string, // Changed to string for canonical key consistency
    tableSchema: string,
    forceRegenerate: boolean = false
  ): Promise<TableDescription & { wasReused: boolean }> {
    // Check for existing context (only works in shared mode)
    if (!forceRegenerate && neo4jService.isSharedNodesEnabled()) {
      try {
        const canonicalKey = `${databaseId}.${tableSchema}.${tableName}`;
        const existingNode = await neo4jService.findTableByCanonicalKey(canonicalKey);
        
        if (existingNode && existingNode.description && existingNode.description.length > 0) {
          console.log(`✨ Context reuse: Found existing description for table ${tableName} (saved LLM call)`);
          
          // Parse existing description into expected format
          // The description field might contain the full structured data or just the description
          try {
            const parsed = JSON.parse(existingNode.description);
            return {
              ...parsed,
              wasReused: true
            };
          } catch {
            // If not JSON, treat as simple description
            return {
              table_name: tableName,
              description: existingNode.description,
              business_purpose: '',
              data_characteristics: '',
              wasReused: true
            };
          }
        }
      } catch (error) {
        // Gracefully degrade if Neo4j is unavailable - don't fail the entire job
        console.warn(`⚠️  Neo4j lookup failed for table ${tableName}, falling back to fresh LLM generation:`, error instanceof Error ? error.message : error);
      }
    }
    
    // No existing context or forced regeneration - call LLM
    const freshDescription = await this.generateTableDescription(tableName, schema, sampleData);
    
    // Persist fresh description back to Neo4j (last-wins update)
    if (neo4jService.isSharedNodesEnabled()) {
      try {
        const canonicalKey = `${databaseId}.${tableSchema}.${tableName}`;
        // Store as JSON string for structured data
        const descriptionJson = JSON.stringify(freshDescription);
        await neo4jService.updateTableDescription(canonicalKey, descriptionJson);
        console.log(`💾 Persisted fresh table description for ${tableName} to shared knowledge graph`);
      } catch (error) {
        console.warn(`⚠️  Failed to persist table description for ${tableName}:`, error instanceof Error ? error.message : error);
      }
    }
    
    return {
      ...freshDescription,
      wasReused: false
    };
  }

  /**
   * Generate or reuse column descriptions with context awareness
   * Checks Neo4j for existing context before calling LLM (cost savings)
   */
  async generateOrReuseColumnDescriptions(
    tableName: string,
    columns: Array<{
      name: string;
      dataType: string;
      sampleValues: any[];
      cardinality?: number;
      nullPercentage?: number;
      databaseId?: string; // Changed to string for canonical key consistency
      tableSchema?: string;
    }>,
    forceRegenerate: boolean = false
  ): Promise<Array<ColumnDescription & { wasReused: boolean }>> {
    const results: Array<ColumnDescription & { wasReused: boolean }> = [];
    
    // Check for existing context for each column
    if (!forceRegenerate && neo4jService.isSharedNodesEnabled()) {
      try {
        for (const col of columns) {
          if (col.databaseId && col.tableSchema) {
            const columnKey = `${col.databaseId}.${col.tableSchema}.${tableName}.${col.name}`;
            try {
              const existingNode = await neo4jService.findColumnByColumnKey(columnKey);
              
              if (existingNode && existingNode.description && existingNode.description.length > 0) {
                console.log(`✨ Context reuse: Found existing description for column ${col.name} (saved LLM call)`);
                
                // Parse existing description
                try {
                  const parsed = JSON.parse(existingNode.description);
                  results.push({
                    ...parsed,
                    wasReused: true
                  });
                } catch {
                  results.push({
                    column_name: col.name,
                    description: existingNode.description,
                    business_meaning: '',
                    data_patterns: '',
                    wasReused: true
                  });
                }
                continue;
              }
            } catch (error) {
              console.warn(`⚠️  Neo4j lookup failed for column ${col.name}, will generate fresh:`, error instanceof Error ? error.message : error);
            }
          }
          
          // No existing context for this column - mark for fresh generation
          results.push({ 
            column_name: col.name, 
            description: '',
            business_meaning: '',
            data_patterns: '',
            wasReused: false 
          } as any);
        }
        
        // If any columns need fresh generation, batch call the LLM for efficiency
        const columnsNeedingGeneration = results
          .map((r, i) => ({ result: r, index: i, column: columns[i] }))
          .filter(item => !item.result.wasReused && !item.result.description);
        
        if (columnsNeedingGeneration.length > 0) {
          const freshDescriptions = await this.generateColumnDescriptions(
            tableName,
            columnsNeedingGeneration.map(item => item.column)
          );
          
          // Merge fresh descriptions back into results and persist to Neo4j (last-wins)
          columnsNeedingGeneration.forEach((item, freshIndex) => {
            const freshDesc = freshDescriptions[freshIndex];
            results[item.index] = {
              ...freshDesc,
              wasReused: false
            };
            
            // Persist fresh description back to Neo4j
            const col = item.column;
            if (col.databaseId && col.tableSchema) {
              const columnKey = `${col.databaseId}.${col.tableSchema}.${tableName}.${col.name}`;
              const descriptionJson = JSON.stringify(freshDesc);
              neo4jService.updateColumnDescription('', descriptionJson, columnKey)
                .then(() => console.log(`💾 Persisted fresh column description for ${col.name} to shared knowledge graph`))
                .catch(error => console.warn(`⚠️  Failed to persist column description for ${col.name}:`, error instanceof Error ? error.message : error));
            }
          });
        }
        
        return results;
      } catch (error) {
        // Gracefully degrade if Neo4j is unavailable
        console.warn(`⚠️  Neo4j context reuse failed, falling back to fresh LLM generation for all columns:`, error instanceof Error ? error.message : error);
      }
    }
    
    // Not in shared mode or forced regeneration - call LLM for all
    const freshDescriptions = await this.generateColumnDescriptions(tableName, columns);
    return freshDescriptions.map(desc => ({
      ...desc,
      wasReused: false
    }));
  }

  async generateTableDescription(
    tableName: string,
    schema: string,
    sampleData: any[]
  ): Promise<TableDescription> {
    const truncatedSample = this.truncateText(JSON.stringify(sampleData, null, 2), 2000);
    
    const prompt = `Analyze this database table and provide a business-focused description.

Table: ${tableName}
Schema: ${schema}
Sample Data: ${truncatedSample}

Generate a JSON response with the following structure:
{
  "table_name": "${tableName}",
  "description": "Clear, business-focused description of what this table stores",
  "business_purpose": "Why this table exists from a business perspective",
  "data_characteristics": "Key patterns and characteristics in the data"
}`;

    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "object",
            properties: {
              table_name: { type: "string" },
              description: { type: "string" },
              business_purpose: { type: "string" },
              data_characteristics: { type: "string" }
            },
            required: ["table_name", "description", "business_purpose", "data_characteristics"]
          }
        },
        contents: prompt
      });

      const result = JSON.parse(response.text || "{}");
      return result as TableDescription;
    } catch (error: any) {
      // Handle quota exhaustion gracefully
      if (error?.status === 'RESOURCE_EXHAUSTED' || error?.message?.includes('quota') || error?.message?.includes('429')) {
        console.warn(`Gemini API quota exhausted for table ${tableName}. Returning fallback description.`);
        return {
          table_name: tableName,
          description: `Table containing ${tableName} data - AI description unavailable due to quota limits`,
          business_purpose: "Business context unavailable - requires AI API access",
          data_characteristics: "Data patterns unavailable - requires AI analysis"
        };
      }
      throw new Error(`Failed to generate table description: ${error}`);
    }
  }

  async generateColumnDescriptions(
    tableName: string,
    columns: Array<{
      name: string;
      dataType: string;
      sampleValues: any[];
      cardinality?: number;
      nullPercentage?: number;
    }>
  ): Promise<ColumnDescription[]> {
    const truncatedColumns = columns.map(col => ({
      ...col,
      sampleValues: col.sampleValues.slice(0, 20) // Limit sample values
    }));

    const prompt = `Analyze these database columns and provide business-focused descriptions.

Table: ${tableName}
Columns: ${JSON.stringify(truncatedColumns, null, 2)}

For each column, generate a JSON object with:
{
  "column_name": "column name",
  "description": "Technical description of the column",
  "business_meaning": "What this column means in business terms",
  "data_patterns": "Patterns observed in the data",
  "enum_values": ["value1", "value2"] // Only if cardinality <= 100
}

Return an array of these objects.`;

    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "array",
            items: {
              type: "object",
              properties: {
                column_name: { type: "string" },
                description: { type: "string" },
                business_meaning: { type: "string" },
                data_patterns: { type: "string" },
                enum_values: {
                  type: "array",
                  items: { type: "string" }
                }
              },
              required: ["column_name", "description", "business_meaning", "data_patterns"]
            }
          }
        },
        contents: prompt
      });

      const result = JSON.parse(response.text || "[]");
      return result as ColumnDescription[];
    } catch (error: any) {
      // Handle quota exhaustion gracefully  
      if (error?.status === 'RESOURCE_EXHAUSTED' || error?.message?.includes('quota') || error?.message?.includes('429')) {
        console.warn(`Gemini API quota exhausted for columns in ${tableName}. Returning fallback descriptions.`);
        return columns.map(col => ({
          column_name: col.name,
          description: `${col.dataType} column - AI description unavailable due to quota limits`,
          business_meaning: "Business context unavailable - requires AI API access",
          data_patterns: `Data type: ${col.dataType}${col.cardinality ? `, Cardinality: ${col.cardinality}` : ''}`,
          enum_values: []
        }));
      }
      throw new Error(`Failed to generate column descriptions: ${error}`);
    }
  }

  async suggestJoins(
    tables: Array<{
      name: string;
      columns: Array<{ name: string; dataType: string }>;
    }>
  ): Promise<JoinSuggestion[]> {
    const prompt = `Analyze these database tables and suggest potential join relationships.

Tables: ${JSON.stringify(tables, null, 2)}

Look for:
1. Exact column name matches (e.g., customer_id in both tables)
2. Semantic similarities (e.g., user_id and customer_id)
3. Common patterns (e.g., id, order_id, product_id)

Return a JSON array of join suggestions with this structure:
{
  "from_table": "table1",
  "from_column": "column1", 
  "to_table": "table2",
  "to_column": "column2",
  "confidence": 0.95, // 0-1 confidence score
  "reasoning": "Why this join makes sense",
  "relationship_type": "one-to-many" // or "many-to-many", "one-to-one"
}`;

    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "array",
            items: {
              type: "object",
              properties: {
                from_table: { type: "string" },
                from_column: { type: "string" },
                to_table: { type: "string" },
                to_column: { type: "string" },
                confidence: { type: "number" },
                reasoning: { type: "string" },
                relationship_type: { type: "string" }
              },
              required: ["from_table", "from_column", "to_table", "to_column", "confidence", "reasoning", "relationship_type"]
            }
          }
        },
        contents: prompt
      });

      const result = JSON.parse(response.text || "[]");
      return result as JoinSuggestion[];
    } catch (error) {
      throw new Error(`Failed to suggest joins: ${error}`);
    }
  }

  async generateSMEQuestions(
    tableName: string,
    schema: string,
    sampleData: any[],
    statisticalAnalysis: any
  ): Promise<SMEQuestionSet> {
    const truncatedSample = this.truncateText(JSON.stringify(sampleData, null, 2), 2000);
    const truncatedStats = this.truncateText(JSON.stringify(statisticalAnalysis, null, 2), 1000);

    const systemPrompt = `You are an expert Data Analyst, and your task is to interview a human Subject Matter Expert (SME) to create high-quality documentation for a database table. Your goal is NOT to generate final descriptions. Your goal is to analyze the table schema and data, form hypotheses, and then generate clarifying questions for the SME to validate your assumptions.

**Your Rules of Engagement:**
1. You will be given the table's schema, a brief description of the data sample, and the sample data itself.
2. For the table as a whole and for **each column**, you must form a preliminary \`hypothesis\` about its purpose.
3. For columns that appear to be categorical (e.g., VARCHAR with a limited number of unique values), you **MUST** populate the \`enum_values_found\` field with the distinct values found in the data sample.
4. Crucially, for each hypothesis, you must generate one or more \`questions_for_user\` to confirm your understanding, identify ambiguity, or uncover hidden business logic. For categorical columns, your question should explicitly ask the user to **define or explain** the found values.
5. Questions should be simple and actionable, ideally multiple-choice, yes/no, or a request for definitions.
6. Pay close attention to columns that look like identifiers, foreign keys, status codes, or contain complex business logic (e.g., dates, monetary values).
7. Your final output **MUST** be a single, well-formed JSON object and nothing else. Do not add any explanatory text before or after the JSON.`;

    const prompt = `**Sampling Information:**
Most recent ${sampleData.length} rows from table ${tableName}

**Schema:**
${schema}

**Sample Data:**
${truncatedSample}

**Statistical Analysis:**
${truncatedStats}`;

    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-pro",
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: "application/json",
          responseSchema: {
            type: "object",
            properties: {
              table_name: { type: "string" },
              sampling_info: { type: "string" },
              table_hypothesis: { type: "string" },
              columns: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    column_name: { type: "string" },
                    data_type: { type: "string" },
                    sample_values: {
                      type: "array",
                      items: { type: "string" }
                    },
                    enum_values_found: {
                      type: "array",
                      items: { type: "string" }
                    },
                    hypothesis: { type: "string" },
                    questions_for_user: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          question_text: { type: "string" },
                          question_type: { type: "string" },
                          options: {
                            type: "array",
                            items: { type: "string" }
                          }
                        },
                        required: ["question_text", "question_type"]
                      }
                    }
                  },
                  required: ["column_name", "data_type", "sample_values", "hypothesis", "questions_for_user"]
                }
              }
            },
            required: ["table_name", "sampling_info", "table_hypothesis", "columns"]
          }
        },
        contents: prompt
      });

      const result = JSON.parse(response.text || "{}");
      return result as SMEQuestionSet;
    } catch (error) {
      throw new Error(`Failed to generate SME questions: ${error}`);
    }
  }

  async generateBatchedContextAndQuestions(
    tables: Array<{
      tableName: string;
      schema: string;
      sampleData: any[];
      columnData: Array<{
        name: string;
        dataType: string;
        sampleValues: any[];
        cardinality?: number;
        nullPercentage?: number;
        distinctValues?: any[];
      }>;
      statisticalAnalysis: any;
    }>
  ): Promise<Array<{
    table: {
      table_name: string;
      description: string;
      business_purpose: string;
      data_characteristics: string;
    } | null;
    columns: Array<{
      column_name: string;
      hypothesis: string;
      questions: Array<{
        question_text: string;
        question_type: "yes_no" | "multiple_choice" | "free_text_definitions";
        options?: string[];
        priority: "high" | "medium" | "low";
      }>;
    }>;
  }>> {
    console.log(`Processing batch of ${tables.length} tables for context generation`);
    
    const systemPrompt = `You are an expert Data Analyst conducting a comprehensive analysis of multiple database tables simultaneously. Your task is twofold:

1. **Generate AI Context**: Provide table-level business description and column-level hypotheses about the data's purpose and meaning for each table.
2. **Generate SME Questions**: Create targeted questions for a Subject Matter Expert to validate your hypotheses and gather additional context.

**Your Rules of Engagement:**
1. For each table overall, provide a clear business description, purpose, and data characteristics.
2. For each column, form a preliminary hypothesis about its purpose and business meaning.
3. For columns with low cardinality (<=100 unique values), use the provided distinct values to inform your hypothesis.
4. Generate 1-3 targeted questions per column to validate your hypotheses, especially for:
   - Categorical columns with enum-like values
   - Columns that appear to be identifiers or foreign keys  
   - Columns with complex business logic (dates, monetary values, status codes)
5. Questions should be actionable: yes/no, multiple-choice, or requests for definitions.
6. Focus on understanding business context, not just technical details.
7. Your output MUST be valid JSON with no additional text.
8. Process ALL tables provided in the batch and return results for each.`;

    // Build the batch prompt for all tables
    const tablesPromptData = tables.map((table, index) => {
      const truncatedSample = this.truncateText(JSON.stringify(table.sampleData, null, 2), 1500);
      const truncatedStats = this.truncateText(JSON.stringify(table.statisticalAnalysis, null, 2), 800);
      
      return `**TABLE ${index + 1}:**
Table: ${table.tableName}

**Schema:**
${table.schema}

**Sample Data (${table.sampleData.length} rows):**
${truncatedSample}

**Statistical Analysis:**
${truncatedStats}

**Column Details with Enum Values:**
${table.columnData.map(col => {
  const distinctVals = col.distinctValues && col.cardinality && col.cardinality <= 100 
    ? `\nDistinct Values: ${JSON.stringify(col.distinctValues.slice(0, 20))}${col.distinctValues.length > 20 ? '... (truncated)' : ''}`
    : '';
  return `- ${col.name} (${col.dataType}): Cardinality: ${col.cardinality || 'unknown'}, Null%: ${col.nullPercentage || 0}${distinctVals}`;
}).join('\n')}`;
    }).join('\n\n---\n\n');

    const prompt = `**Batch Analysis Request for ${tables.length} Tables:**

${tablesPromptData}

**Required JSON Response Format:**
{
  "results": [
    {
      "table": {
        "table_name": "exact_table_name_1",
        "description": "Clear business description",
        "business_purpose": "What this table is used for",
        "data_characteristics": "Key data patterns and insights"
      },
      "columns": [
        {
          "column_name": "exact_column_name",
          "hypothesis": "Your hypothesis about this column's purpose",
          "questions": [
            {
              "question_text": "Specific question for SME validation",
              "question_type": "yes_no",
              "priority": "high"
            }
          ]
        }
      ]
    }
  ]
}

Generate complete analysis for ALL ${tables.length} tables provided.`;

    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-pro",
        config: {
          systemInstruction: systemPrompt
        },
        contents: prompt
      });

      const result = JSON.parse(response.text || "{}");
      console.log(`Batch processing completed for ${tables.length} tables`);
      
      if (!result.results || !Array.isArray(result.results)) {
        throw new Error('Invalid batch response format from Gemini');
      }
      
      return result.results;
    } catch (error) {
      console.error(`Batch context generation failed for ${tables.length} tables:`, error);
      // Fallback to individual processing if batch fails
      console.log('Falling back to individual table processing...');
      const results = [];
      for (const table of tables) {
        try {
          const individualResult = await this.generateContextAndQuestions(
            table.tableName,
            table.schema,
            table.sampleData,
            table.columnData,
            table.statisticalAnalysis
          );
          results.push(individualResult);
        } catch (individualError) {
          console.error(`Failed to process table ${table.tableName}:`, individualError);
          results.push({
            table: {
              table_name: table.tableName,
              description: `Error processing table: ${individualError}`,
              business_purpose: "Unknown due to processing error",
              data_characteristics: "Unable to analyze"
            },
            columns: table.columnData.map(col => ({
              column_name: col.name,
              hypothesis: "Unable to generate hypothesis due to processing error",
              questions: [{
                question_text: `What is the business purpose of the ${col.name} column?`,
                question_type: "free_text_definitions" as const,
                priority: "medium" as const
              }]
            }))
          });
        }
      }
      return results;
    }
  }

  async generateContextAndQuestions(
    tableName: string,
    schema: string,
    sampleData: any[],
    columnData: Array<{
      name: string;
      dataType: string;
      sampleValues: any[];
      cardinality?: number;
      nullPercentage?: number;
      distinctValues?: any[];
    }>,
    statisticalAnalysis: any
  ): Promise<{
    table: {
      table_name: string;
      description: string;
      business_purpose: string;
      data_characteristics: string;
    } | null;
    columns: Array<{
      column_name: string;
      hypothesis: string;
      questions: Array<{
        question_text: string;
        question_type: "yes_no" | "multiple_choice" | "free_text_definitions";
        options?: string[];
        priority: "high" | "medium" | "low";
      }>;
    }>;
  }> {
    const truncatedSample = this.truncateText(JSON.stringify(sampleData, null, 2), 2000);
    const truncatedStats = this.truncateText(JSON.stringify(statisticalAnalysis, null, 2), 1000);

    const systemPrompt = `You are an expert Data Analyst conducting a comprehensive analysis of a database table. Your task is twofold:

1. **Generate AI Context**: Provide table-level business description and column-level hypotheses about the data's purpose and meaning.
2. **Generate SME Questions**: Create targeted questions for a Subject Matter Expert to validate your hypotheses and gather additional context.

**Your Rules of Engagement:**
1. For the table overall, provide a clear business description, purpose, and data characteristics.
2. For each column, form a preliminary hypothesis about its purpose and business meaning.
3. For columns with low cardinality (<=100 unique values), use the provided distinct values to inform your hypothesis.
4. Generate 1-3 targeted questions per column to validate your hypotheses, especially for:
   - Categorical columns with enum-like values
   - Columns that appear to be identifiers or foreign keys  
   - Columns with complex business logic (dates, monetary values, status codes)
5. Questions should be actionable: yes/no, multiple-choice, or requests for definitions.
6. Focus on understanding business context, not just technical details.
7. Your output MUST be valid JSON with no additional text.`;

    const prompt = `**Table Analysis Request:**
Table: ${tableName}

**Schema:**
${schema}

**Sample Data (${sampleData.length} rows):**
${truncatedSample}

**Statistical Analysis:**
${truncatedStats}

**Column Details with Enum Values:**
${JSON.stringify(columnData.map(col => ({
  name: col.name,
  dataType: col.dataType,
  cardinality: col.cardinality,
  nullPercentage: col.nullPercentage,
  sampleValues: col.sampleValues.slice(0, 10),
  distinctValues: col.distinctValues // Only present for low cardinality columns
})), null, 2)}`;

    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-pro",
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: "application/json",
          responseSchema: {
            type: "object",
            properties: {
              table: {
                type: "object",
                properties: {
                  table_name: { type: "string" },
                  description: { type: "string" },
                  business_purpose: { type: "string" },
                  data_characteristics: { type: "string" }
                },
                required: ["table_name", "description", "business_purpose", "data_characteristics"]
              },
              columns: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    column_name: { type: "string" },
                    hypothesis: { type: "string" },
                    questions: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          question_text: { type: "string" },
                          question_type: { 
                            type: "string",
                            enum: ["yes_no", "multiple_choice", "free_text_definitions"]
                          },
                          options: {
                            type: "array",
                            items: { type: "string" }
                          },
                          priority: { 
                            type: "string",
                            enum: ["high", "medium", "low"]
                          }
                        },
                        required: ["question_text", "question_type", "priority"]
                      }
                    }
                  },
                  required: ["column_name", "hypothesis", "questions"]
                }
              }
            },
            required: ["table", "columns"]
          }
        },
        contents: prompt
      });

      const result = JSON.parse(response.text || "{}");
      return result;
    } catch (error: any) {
      // Handle quota exhaustion gracefully
      if (error?.status === 'RESOURCE_EXHAUSTED' || error?.message?.includes('quota') || error?.message?.includes('429')) {
        console.warn(`Gemini API quota exhausted for table ${tableName}. Returning fallback response.`);
        return {
          table: {
            table_name: tableName,
            description: `Table containing ${tableName} data - AI description unavailable due to quota limits`,
            business_purpose: "Business context unavailable - requires AI API access",
            data_characteristics: "Data patterns unavailable - requires AI analysis"
          },
          columns: columnData.map(col => ({
            column_name: col.name,
            hypothesis: `${col.dataType} column - AI hypothesis unavailable due to quota limits`,
            questions: [{
              question_text: `What is the business purpose of the ${col.name} column?`,
              question_type: "free_text_definitions" as const,
              priority: "medium" as const
            }]
          }))
        };
      }
      throw new Error(`Failed to generate context and questions: ${error}`);
    }
  }

  async mergeColumnContextWithSMEFeedback(
    columnName: string,
    tableName: string,
    originalAIDescription: string,
    smeResponses: Array<{
      questionText: string;
      response: string;
      questionType: string;
    }>
  ): Promise<string> {
    try {
      const systemPrompt = `You are an expert data analyst responsible for creating comprehensive column descriptions by combining AI analysis with Subject Matter Expert (SME) feedback.

Your task is to create a refined, accurate description that incorporates both the original AI hypothesis and the validated SME responses.

Rules:
1. Start with the original AI description as your baseline
2. Incorporate SME feedback to correct, refine, or expand the description
3. If SME responses contradict the AI description, prioritize the SME input
4. If SME responses provide additional context, integrate it seamlessly
5. Maintain a professional, clear tone suitable for technical documentation
6. Keep the description concise but comprehensive (2-3 sentences max)
7. Focus on business purpose and meaning, not just technical details`;

      const prompt = `
**Column:** ${columnName} (in table: ${tableName})

**Original AI Description:**
${originalAIDescription}

**SME Feedback:**
${smeResponses.map(r => `Q: ${r.questionText}\nA: ${r.response}\nType: ${r.questionType}`).join('\n\n')}

**Task:** Create a refined column description that incorporates the SME feedback while maintaining the valuable insights from the AI analysis. Return only the description text, no additional formatting.`;

      const response = await ai.models.generateContent({
        model: "gemini-2.5-pro",
        config: {
          systemInstruction: systemPrompt
        },
        contents: prompt
      });

      return response.text?.trim() || originalAIDescription;
    } catch (error) {
      console.warn(`Failed to merge SME feedback for column ${columnName}:`, error);
      return originalAIDescription; // Fallback to original description
    }
  }

  async generateEnumValueContext(
    tableName: string,
    columnName: string,
    columnDataType: string,
    enumValues: string[],
    columnDescription?: string
  ): Promise<Array<{value: string, context: string, hypothesis: string}>> {
    const prompt = `Analyze these enum values from a database column and provide business context and hypotheses for each value.

Table: ${tableName}
Column: ${columnName}
Data Type: ${columnDataType}
Column Description: ${columnDescription || 'No description available'}
Enum Values: ${JSON.stringify(enumValues)}

For each enum value, provide:
1. Context: What this value likely represents in business terms
2. Hypothesis: Your hypothesis about when/why this value would be used

Generate a JSON response with this structure:
{
  "enum_contexts": [
    {
      "value": "exact_enum_value",
      "context": "Business context explaining what this value represents",
      "hypothesis": "Hypothesis about when and why this value is used"
    }
  ]
}`;

    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "object",
            properties: {
              enum_contexts: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    value: { type: "string" },
                    context: { type: "string" },
                    hypothesis: { type: "string" }
                  },
                  required: ["value", "context", "hypothesis"]
                }
              }
            },
            required: ["enum_contexts"]
          }
        },
        contents: prompt
      });

      const result = JSON.parse(response.text || "{}");
      return result.enum_contexts || [];
    } catch (error: any) {
      // Handle quota exhaustion gracefully
      if (error?.status === 'RESOURCE_EXHAUSTED' || error?.message?.includes('quota') || error?.message?.includes('429')) {
        console.warn(`Gemini API quota exhausted for enum values in ${tableName}.${columnName}. Returning fallback context.`);
        return enumValues.map(value => ({
          value,
          context: `Enum value '${value}' - AI context unavailable due to quota limits`,
          hypothesis: "Business hypothesis unavailable - requires AI API access"
        }));
      }
      throw new Error(`Failed to generate enum value context: ${error}`);
    }
  }
}

export const geminiService = new GeminiService();
