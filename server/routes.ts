import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { postgresAnalyzer } from "./services/postgres-analyzer";
import { neo4jService } from "./services/neo4j-service";
import { geminiService } from "./services/gemini";
import { schemaAnalyzer } from "./services/schema-analyzer";
import { statisticalAnalyzer } from "./services/statistical-analyzer";
import { semanticAnalyzer } from "./services/semantic-analyzer";
import { smeInterviewService } from "./services/sme-interview";
import { insertConnectionSchema, insertDatabaseSchema, insertTableSchema, insertAgentPersonaSchema } from "@shared/schema";
import { z } from "zod";

export async function registerRoutes(app: Express): Promise<Server> {
  // Connection management routes
  app.post("/api/connections", async (req, res) => {
    try {
      const connectionData = insertConnectionSchema.parse(req.body);
      const userId = req.body.userId || "default-user"; // In real app, get from auth
      
      const connection = await storage.createConnection({
        ...connectionData,
        userId
      });
      
      res.json(connection);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid request" });
    }
  });

  app.get("/api/connections", async (req, res) => {
    try {
      const userId = req.query.userId as string || "default-user";
      const connections = await storage.getConnectionsByUserId(userId);
      res.json(connections);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to fetch connections" });
    }
  });

  // Connection testing routes
  app.post("/api/connections/:id/test", async (req, res) => {
    try {
      const { id } = req.params;
      const connection = await storage.getConnection(id);
      
      if (!connection) {
        return res.status(404).json({ error: "Connection not found" });
      }

      let testResult;
      
      switch (connection.type) {
        case 'postgresql':
          const connected = await postgresAnalyzer.connect(connection.config as any);
          if (connected) {
            testResult = await postgresAnalyzer.testConnection();
            await postgresAnalyzer.disconnect();
          } else {
            testResult = { success: false, error: "Failed to connect" };
          }
          break;
          
        case 'neo4j':
          const neo4jConnected = await neo4jService.connect(connection.config as any);
          if (neo4jConnected) {
            testResult = await neo4jService.testConnection();
            await neo4jService.disconnect();
          } else {
            testResult = { success: false, error: "Failed to connect" };
          }
          break;
          
        case 'gemini':
          // Test Gemini API by making a simple request
          try {
            await geminiService.generateTableDescription("test", "test", []);
            testResult = { success: true, latency: 100 };
          } catch (error) {
            testResult = { success: false, error: error instanceof Error ? error.message : "API test failed" };
          }
          break;
          
        default:
          testResult = { success: false, error: "Unknown connection type" };
      }

      // Update connection status
      await storage.updateConnectionStatus(
        id, 
        testResult.success ? "connected" : "failed",
        new Date()
      );

      res.json(testResult);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Test failed" });
    }
  });

  // Database routes
  app.post("/api/databases", async (req, res) => {
    try {
      const databaseData = insertDatabaseSchema.parse(req.body);
      const database = await storage.createDatabase(databaseData);
      res.json(database);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid request" });
    }
  });

  app.get("/api/databases", async (req, res) => {
    try {
      const connectionId = req.query.connectionId as string;
      if (!connectionId) {
        return res.status(400).json({ error: "connectionId is required" });
      }
      
      const databases = await storage.getDatabasesByConnectionId(connectionId);
      res.json(databases);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to fetch databases" });
    }
  });

  // Schema analysis routes
  app.post("/api/databases/:id/analyze-schema", async (req, res) => {
    try {
      const { id } = req.params;
      const result = await schemaAnalyzer.analyzeDatabase(id);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Schema analysis failed" });
    }
  });

  app.get("/api/databases/:id/tables", async (req, res) => {
    try {
      const { id } = req.params;
      const tables = await storage.getTablesByDatabaseId(id);
      res.json(tables);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to fetch tables" });
    }
  });

  // Table management routes
  app.post("/api/tables/:id/select", async (req, res) => {
    try {
      const { id } = req.params;
      const { isSelected, sampleSize } = req.body;
      
      await storage.updateTableSelection(id, isSelected, sampleSize);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to update table selection" });
    }
  });

  app.post("/api/tables/:id/analyze-columns", async (req, res) => {
    try {
      const { id } = req.params;
      await schemaAnalyzer.analyzeTableColumns(id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Column analysis failed" });
    }
  });

  app.get("/api/tables/:id/columns", async (req, res) => {
    try {
      const { id } = req.params;
      const columns = await storage.getColumnsByTableId(id);
      res.json(columns);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to fetch columns" });
    }
  });

  app.get("/api/tables/:id/sample-data", async (req, res) => {
    try {
      const { id } = req.params;
      const sampleSize = req.query.sampleSize ? parseInt(req.query.sampleSize as string) : undefined;
      const sampleData = await schemaAnalyzer.getSampleData(id, sampleSize);
      res.json(sampleData);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to fetch sample data" });
    }
  });

  // Statistical analysis routes
  app.post("/api/tables/:id/analyze-statistics", async (req, res) => {
    try {
      const { id } = req.params;
      
      // Create analysis job
      const table = await storage.getTable(id);
      if (!table) {
        return res.status(404).json({ error: "Table not found" });
      }

      // Only allow analysis on selected tables
      if (!table.isSelected) {
        return res.status(400).json({ error: "Cannot analyze unselected table. Please select the table first." });
      }

      // Log the analysis request for debugging
      console.log(`Starting statistical analysis for table: ${table.name} (${id}) in database: ${table.databaseId}`);
      console.log(`Table selected: ${table.isSelected}`)

      const job = await storage.createAnalysisJob({
        databaseId: table.databaseId,
        type: "statistical",
        status: "running",
        progress: 0,
        result: null,
        error: null,
        startedAt: new Date(),
        completedAt: null
      });

      // Run analysis in background
      statisticalAnalyzer.analyzeTable(id, (progress) => {
        storage.updateAnalysisJob(job.id, { progress });
      }).then(result => {
        storage.updateAnalysisJob(job.id, {
          status: "completed",
          progress: 100,
          result: JSON.stringify(result),
          completedAt: new Date()
        });
      }).catch(error => {
        storage.updateAnalysisJob(job.id, {
          status: "failed",
          error: error.message,
          completedAt: new Date()
        });
      });

      res.json(job);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Statistical analysis failed" });
    }
  });

  // Database-level statistical analysis route - analyze all selected tables
  app.post("/api/databases/:id/analyze-statistics", async (req, res) => {
    console.log(`[DEBUG] Hit database-level statistical analysis route for database: ${req.params.id}, method: ${req.method}`);
    try {
      const { id } = req.params;
      
      // Get all selected tables for this database
      const tables = await storage.getSelectedTables(id);
      if (tables.length === 0) {
        return res.status(400).json({ error: "No tables selected for analysis. Please select tables first." });
      }

      console.log(`Starting statistical analysis for database ${id} with ${tables.length} selected tables`);

      // Create a database-level analysis job
      const job = await storage.createAnalysisJob({
        databaseId: id,
        type: "statistical",
        status: "running",
        progress: 0,
        result: null,
        error: null,
        startedAt: new Date(),
        completedAt: null
      });

      // Run analysis for all selected tables in background
      const analyzeAllTables = async () => {
        const results = [];
        let totalProgress = 0;
        
        for (let i = 0; i < tables.length; i++) {
          const table = tables[i];
          
          try {
            console.log(`Analyzing table ${i + 1}/${tables.length}: ${table.name}`);
            
            const result = await statisticalAnalyzer.analyzeTable(table.id, (columnProgress) => {
              // Update progress: (completed tables + current table progress) / total tables
              const overallProgress = Math.round(((i + (columnProgress / 100)) / tables.length) * 100);
              storage.updateAnalysisJob(job.id, { progress: overallProgress });
            });
            
            results.push(result);
            totalProgress = Math.round(((i + 1) / tables.length) * 100);
            await storage.updateAnalysisJob(job.id, { progress: totalProgress });
            
          } catch (error) {
            console.error(`Failed to analyze table ${table.name}:`, error);
            results.push({ error: error instanceof Error ? error.message : "Unknown error", tableId: table.id, tableName: table.name });
          }
        }

        return results;
      };

      // Start analysis in background
      analyzeAllTables().then(results => {
        storage.updateAnalysisJob(job.id, {
          status: "completed",
          progress: 100,
          result: { tables: results },
          completedAt: new Date()
        });
      }).catch(error => {
        storage.updateAnalysisJob(job.id, {
          status: "failed",
          error: error.message,
          completedAt: new Date()
        });
      });

      res.json(job);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Database statistical analysis failed" });
    }
  });

  app.get("/api/databases/:id/statistical-summary", async (req, res) => {
    try {
      const { id } = req.params;
      const summary = await statisticalAnalyzer.generateStatisticalSummary(id);
      res.json(summary);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to generate summary" });
    }
  });

  // AI context generation routes
  app.post("/api/databases/:id/generate-context", async (req, res) => {
    try {
      const { id } = req.params;
      
      const job = await storage.createAnalysisJob({
        databaseId: id,
        type: "ai_context",
        status: "running",
        progress: 0,
        result: null,
        error: null,
        startedAt: new Date(),
        completedAt: null
      });

      // Get selected tables
      const tables = await storage.getSelectedTables(id);
      const results = [];

      for (let i = 0; i < tables.length; i++) {
        const table = tables[i];
        
        try {
          // Get sample data and columns
          const sampleData = await schemaAnalyzer.getSampleData(table.id);
          const columns = await storage.getColumnsByTableId(table.id);
          
          // Generate table description
          const schema = `CREATE TABLE ${table.schema}.${table.name} (\n${columns.map(c => `  ${c.name} ${c.dataType}`).join(',\n')}\n);`;
          const tableDesc = await geminiService.generateTableDescription(table.name, schema, sampleData);
          
          // Generate column descriptions
          const columnData = columns.map(c => ({
            name: c.name,
            dataType: c.dataType,
            sampleValues: sampleData.map(row => row[c.name]).filter(v => v != null).slice(0, 10),
            cardinality: c.cardinality ?? undefined,
            nullPercentage: parseFloat(c.nullPercentage || '0')
          }));
          
          const columnDescs = await geminiService.generateColumnDescriptions(table.name, columnData);
          
          results.push({
            table: tableDesc,
            columns: columnDescs
          });
          
          const progress = Math.round(((i + 1) / tables.length) * 100);
          await storage.updateAnalysisJob(job.id, { progress });
          
        } catch (error) {
          console.error(`Failed to generate context for table ${table.name}:`, error);
        }
      }

      await storage.updateAnalysisJob(job.id, {
        status: "completed",
        progress: 100,
        result: JSON.stringify(results),
        completedAt: new Date()
      });

      res.json(job);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Context generation failed" });
    }
  });

  // Semantic analysis routes
  app.post("/api/databases/:id/analyze-joins", async (req, res) => {
    try {
      const { id } = req.params;
      
      const job = await storage.createAnalysisJob({
        databaseId: id,
        type: "join_detection",
        status: "running",
        progress: 0,
        result: null,
        error: null,
        startedAt: new Date(),
        completedAt: null
      });

      // Run semantic analysis
      const joinCandidates = await semanticAnalyzer.analyzeJoinCandidates(id);
      
      await storage.updateAnalysisJob(job.id, {
        status: "completed",
        progress: 100,
        result: JSON.stringify(joinCandidates),
        completedAt: new Date()
      });

      res.json(job);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Join analysis failed" });
    }
  });

  // SME Interview routes
  app.post("/api/tables/:id/generate-questions", async (req, res) => {
    try {
      const { id } = req.params;
      const interview = await smeInterviewService.generateQuestionsForTable(id);
      res.json(interview);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Question generation failed" });
    }
  });

  app.get("/api/databases/:id/sme-questions", async (req, res) => {
    try {
      const { id } = req.params;
      const questions = await storage.getQuestionsByDatabaseId(id);
      res.json(questions);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to fetch questions" });
    }
  });

  app.post("/api/sme-questions/:id/answer", async (req, res) => {
    try {
      const { id } = req.params;
      const { response } = req.body;
      
      if (!response) {
        return res.status(400).json({ error: "Response is required" });
      }
      
      await storage.answerSmeQuestion(id, response);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to save answer" });
    }
  });

  app.get("/api/databases/:id/sme-progress", async (req, res) => {
    try {
      const { id } = req.params;
      const progress = await smeInterviewService.getInterviewProgress(id);
      res.json(progress);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to get progress" });
    }
  });

  // Combined AI context generation and SME question generation
  app.post("/api/databases/:id/generate-context-and-questions", async (req, res) => {
    try {
      const { id } = req.params;
      
      // Get selected tables first to validate before creating job
      const tables = await storage.getSelectedTables(id);
      if (tables.length === 0) {
        return res.status(400).json({ error: "No tables selected for analysis. Please select tables first." });
      }
      
      const job = await storage.createAnalysisJob({
        databaseId: id,
        type: "ai_context", // We'll use the same type for now
        status: "running",
        progress: 0,
        result: null,
        error: null,
        startedAt: new Date(),
        completedAt: null
      });
      
      const results = [];

      for (let i = 0; i < tables.length; i++) {
        const table = tables[i];
        
        try {
          // Get sample data and columns
          const sampleData = await schemaAnalyzer.getSampleData(table.id);
          const columns = await storage.getColumnsByTableId(table.id);
          
          // Get statistical analysis for richer context
          const statisticalResults = await statisticalAnalyzer.analyzeTable(table.id);
          
          // Generate schema string
          const schema = `CREATE TABLE ${table.schema}.${table.name} (\n${columns.map(c => `  ${c.name} ${c.dataType}`).join(',\n')}\n);`;
          
          // Helper function to safely parse JSON arrays
          const safeParseArray = (value: any): any[] => {
            if (!value) return [];
            if (Array.isArray(value)) return value;
            if (typeof value === 'string') {
              if (value.trim() === '') return [];
              try {
                const parsed = JSON.parse(value);
                return Array.isArray(parsed) ? parsed : [];
              } catch {
                return [];
              }
            }
            return [];
          };
          
          // Prepare column data with enhanced information including enum values
          const columnData = columns.map(c => {
            const distinctValues = safeParseArray(c.distinctValues);
            return {
              name: c.name,
              dataType: c.dataType,
              sampleValues: sampleData.map(row => row[c.name]).filter(v => v != null).slice(0, 10),
              cardinality: c.cardinality ?? undefined,
              nullPercentage: parseFloat(c.nullPercentage || '0'),
              distinctValues: c.cardinality && c.cardinality <= 100 ? distinctValues : undefined
            };
          });
          
          // Use combined Gemini service method (to be implemented)
          // const contextAndQuestions = await geminiService.generateContextAndQuestions(
          //   table.name,
          //   schema,
          //   sampleData,
          //   columnData,
          //   statisticalResults
          // );
          
          // Temporary placeholder until method is implemented
          const contextAndQuestions = {
            table: null,
            columns: []
          };
          
          // Store AI descriptions for table and columns
          if (contextAndQuestions.table) {
            // TODO: Store table description when we have table-level AI description field
          }
          
          // Store column descriptions and SME questions
          for (const columnResult of contextAndQuestions.columns || []) {
            const column = columns.find(c => c.name === columnResult.column_name);
            if (!column) continue;

            // Store column AI description
            await storage.updateColumnStats(column.id, {
              aiDescription: columnResult.hypothesis
            });

            // Create SME questions for this column
            for (const question of columnResult.questions || []) {
              await storage.createSmeQuestion({
                tableId: table.id,
                columnId: column.id,
                questionType: question.question_type || 'column',
                questionText: question.question_text,
                options: question.options ? JSON.stringify(question.options) : null,
                priority: question.priority || 'medium'
              });
            }

            // Add enum values question for low cardinality columns
            if (columnResult.enum_values && columnResult.enum_values.length > 0) {
              await storage.createSmeQuestion({
                tableId: table.id,
                columnId: column.id,
                questionType: 'column',
                questionText: `We found these distinct values in ${columnResult.column_name}: ${columnResult.enum_values.join(', ')}. Please define what each value means.`,
                priority: 'high'
              });
            }
          }
          
          results.push({
            table: table.name,
            context: contextAndQuestions.table,
            columns: contextAndQuestions.columns,
            questionsGenerated: contextAndQuestions.columns?.reduce((total: number, col: any) => total + (col.questions?.length || 0), 0) || 0
          });
          
          const progress = Math.round(((i + 1) / tables.length) * 100);
          await storage.updateAnalysisJob(job.id, { progress });
          
        } catch (error) {
          console.error(`Failed to generate context and questions for table ${table.name}:`, error);
        }
      }

      await storage.updateAnalysisJob(job.id, {
        status: "completed",
        progress: 100,
        result: JSON.stringify(results),
        completedAt: new Date()
      });

      res.json(job);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Context and question generation failed" });
    }
  });

  // Comprehensive data export endpoint with multiple formats
  app.get("/api/databases/:id/export-data", async (req, res) => {
    try {
      const { id } = req.params;
      const format = req.query.format as string || 'json';
      
      // Get all data for this database
      const database = await storage.getDatabase(id);
      if (!database) {
        return res.status(404).json({ error: "Database not found" });
      }
      
      const tables = await storage.getTablesByDatabaseId(id);
      const selectedTables = tables.filter(t => t.isSelected);
      const personas = await storage.getPersonasByDatabaseId(id);
      const analysisJobs = await storage.getAnalysisJobs(id);
      const smeQuestions = await storage.getQuestionsByDatabaseId(id);
      
      // Get detailed column and foreign key data
      const allTableData = await Promise.all(tables.map(async (table) => {
        const columns = await storage.getColumnsByTableId(table.id);
        const foreignKeys = await storage.getForeignKeysByTableId(table.id);
        return { ...table, columns, foreignKeys };
      }));
      
      const exportData = {
        database: {
          id: database.id,
          name: database.name,
          schema: database.schema,
          exported_at: new Date().toISOString()
        },
        summary: {
          total_tables: tables.length,
          selected_tables: selectedTables.length,
          total_columns: allTableData.reduce((sum, t) => sum + t.columns.length, 0),
          analysis_jobs: analysisJobs.length,
          completed_jobs: analysisJobs.filter(j => j.status === 'completed').length,
          sme_questions: smeQuestions.length,
          answered_questions: smeQuestions.filter(q => q.isAnswered).length
        },
        tables: allTableData.map(table => ({
          id: table.id,
          name: table.name,
          schema: table.schema,
          selected: table.isSelected,
          row_count: table.rowCount,
          column_count: table.columnCount,
          sample_size: table.sampleSize,
          columns: table.columns.map(col => ({
            name: col.name,
            data_type: col.dataType,
            is_nullable: col.isNullable,
            is_unique: col.isUnique,
            cardinality: col.cardinality,
            null_percentage: col.nullPercentage,
            min_value: col.minValue,
            max_value: col.maxValue,
            distinct_values: col.distinctValues,
            ai_description: col.aiDescription,
            sme_validated: col.smeValidated
          })),
          foreign_keys: table.foreignKeys.map(fk => ({
            from_column: fk.fromColumnId,
            to_table: allTableData.find(t => t.id === fk.toTableId)?.name,
            to_column: fk.toColumnId,
            confidence: fk.confidence,
            validated: fk.isValidated
          }))
        })),
        statistical_analysis: {
          low_cardinality_columns: allTableData.flatMap(t => 
            t.columns.filter(c => c.cardinality && c.cardinality <= 100)
              .map(c => ({ table: t.name, column: c.name, cardinality: c.cardinality }))
          ),
          high_null_columns: allTableData.flatMap(t => 
            t.columns.filter(c => c.nullPercentage && parseFloat(c.nullPercentage) > 40)
              .map(c => ({ table: t.name, column: c.name, null_percentage: c.nullPercentage }))
          ),
          potential_join_columns: allTableData.flatMap(t => 
            t.columns.filter(c => c.name.toLowerCase().includes('id') || c.isUnique)
              .map(c => ({ table: t.name, column: c.name, data_type: c.dataType, is_unique: c.isUnique }))
          )
        },
        agent_personas: personas,
        analysis_jobs: analysisJobs.map(job => ({
          id: job.id,
          type: job.type,
          status: job.status,
          progress: job.progress,
          result: job.result,
          error: job.error,
          started_at: job.startedAt,
          completed_at: job.completedAt
        })),
        sme_questions: smeQuestions.map(q => ({
          id: q.id,
          table: tables.find(t => t.id === q.tableId)?.name,
          column: allTableData.flatMap(t => t.columns).find(c => c.id === q.columnId)?.name,
          question_type: q.questionType,
          question_text: q.questionText,
          options: q.options,
          response: q.response,
          is_answered: q.isAnswered,
          priority: q.priority
        }))
      };
      
      if (format === 'csv') {
        // Helper function to escape CSV values
        const escapeCSV = (value: any): string => {
          if (value === null || value === undefined) return '';
          const str = String(value);
          if (str.includes('"') || str.includes(',') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
          }
          return str;
        };
        
        // Generate comprehensive CSV export
        let csvOutput = `DATABASE EXPORT - ${database.name}\n`;
        csvOutput += `Exported: ${new Date().toISOString()}\n\n`;
        
        // Summary section
        csvOutput += 'SUMMARY\n';
        csvOutput += 'Metric,Value\n';
        csvOutput += `Total Tables,${exportData.summary.total_tables}\n`;
        csvOutput += `Selected Tables,${exportData.summary.selected_tables}\n`;
        csvOutput += `Total Columns,${exportData.summary.total_columns}\n`;
        csvOutput += `Analysis Jobs,${exportData.summary.analysis_jobs}\n`;
        csvOutput += `Completed Jobs,${exportData.summary.completed_jobs}\n`;
        csvOutput += `SME Questions,${exportData.summary.sme_questions}\n`;
        csvOutput += `Answered Questions,${exportData.summary.answered_questions}\n\n`;
        
        // Tables and Columns
        csvOutput += 'TABLES AND COLUMNS\n';
        csvOutput += 'Table,Column,DataType,IsNullable,IsUnique,Cardinality,NullPercentage,MinValue,MaxValue,AIDescription,SMEValidated,Selected\n';
        exportData.tables.forEach(table => {
          table.columns.forEach(col => {
            csvOutput += `${escapeCSV(table.name)},${escapeCSV(col.name)},${escapeCSV(col.data_type)},${escapeCSV(col.is_nullable)},${escapeCSV(col.is_unique)},${escapeCSV(col.cardinality)},${escapeCSV(col.null_percentage)},${escapeCSV(col.min_value)},${escapeCSV(col.max_value)},${escapeCSV(col.ai_description)},${escapeCSV(col.sme_validated)},${escapeCSV(table.selected)}\n`;
          });
        });
        csvOutput += '\n';
        
        // Statistical insights
        if (exportData.statistical_analysis.low_cardinality_columns.length > 0) {
          csvOutput += 'LOW CARDINALITY COLUMNS (<= 100 unique values)\n';
          csvOutput += 'Table,Column,Cardinality\n';
          exportData.statistical_analysis.low_cardinality_columns.forEach(item => {
            csvOutput += `${escapeCSV(item.table)},${escapeCSV(item.column)},${escapeCSV(item.cardinality)}\n`;
          });
          csvOutput += '\n';
        }
        
        if (exportData.statistical_analysis.high_null_columns.length > 0) {
          csvOutput += 'HIGH NULL COLUMNS (> 40% nulls)\n';
          csvOutput += 'Table,Column,NullPercentage\n';
          exportData.statistical_analysis.high_null_columns.forEach(item => {
            csvOutput += `${escapeCSV(item.table)},${escapeCSV(item.column)},${escapeCSV(item.null_percentage)}\n`;
          });
          csvOutput += '\n';
        }
        
        // Analysis jobs results
        if (exportData.analysis_jobs.length > 0) {
          csvOutput += 'ANALYSIS JOBS\n';
          csvOutput += 'Type,Status,Progress,StartedAt,CompletedAt,Error\n';
          exportData.analysis_jobs.forEach(job => {
            csvOutput += `${escapeCSV(job.type)},${escapeCSV(job.status)},${escapeCSV(job.progress)}%,${escapeCSV(job.started_at)},${escapeCSV(job.completed_at)},${escapeCSV(job.error)}\n`;
          });
          csvOutput += '\n';
        }
        
        // SME Questions
        if (exportData.sme_questions.length > 0) {
          csvOutput += 'SME QUESTIONS\n';
          csvOutput += 'Table,Column,QuestionType,Question,Priority,Response,IsAnswered\n';
          exportData.sme_questions.forEach(q => {
            csvOutput += `${escapeCSV(q.table)},${escapeCSV(q.column)},${escapeCSV(q.question_type)},${escapeCSV(q.question_text)},${escapeCSV(q.priority)},${escapeCSV(q.response)},${escapeCSV(q.is_answered)}\n`;
          });
        }
        
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${database.name}-complete-export.csv"`);
        res.send(csvOutput);
      } else {
        // JSON export
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=${database.name}-complete-export.json`);
        res.json(exportData);
      }
    } catch (error) {
      console.error('Export error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Data export failed" });
    }
  });

  app.get("/api/databases/:id/export-csv", async (req, res) => {
    try {
      const { id } = req.params;
      const csvData = await smeInterviewService.exportToCSV(id);
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=sme-questions.csv');
      
      // Convert to CSV format
      let csvOutput = '';
      
      // Add Agent Persona questions
      if (csvData.agentPersonaQuestions.length > 0) {
        csvOutput += 'AGENT PERSONA QUESTIONS\n';
        csvOutput += 'Persona,Question,Type,Priority,Options,Response\n';
        csvData.agentPersonaQuestions.forEach(q => {
          csvOutput += `"${q.persona}","${q.question}","${q.questionType}","${q.priority}","${q.options || ''}","${q.response || ''}"\n`;
        });
        csvOutput += '\n';
      }
      
      // Add table questions
      if (csvData.tableQuestions.length > 0) {
        csvOutput += 'TABLE QUESTIONS\n';
        csvOutput += 'Table,Question,Type,Priority,Options,Response\n';
        csvData.tableQuestions.forEach(q => {
          csvOutput += `"${q.table}","${q.question}","${q.questionType}","${q.priority}","${q.options || ''}","${q.response || ''}"\n`;
        });
        csvOutput += '\n';
      }
      
      // Add column questions
      if (csvData.columnQuestions.length > 0) {
        csvOutput += 'COLUMN QUESTIONS\n';
        csvOutput += 'Table,Column,DataType,Hypothesis,Question,Type,Priority,Options,Response\n';
        csvData.columnQuestions.forEach(q => {
          csvOutput += `"${q.table}","${q.column}","${q.dataType}","${q.hypothesis}","${q.question}","${q.questionType}","${q.priority}","${q.options || ''}","${q.response || ''}"\n`;
        });
        csvOutput += '\n';
      }
      
      // Add relationship questions
      if (csvData.relationshipQuestions.length > 0) {
        csvOutput += 'RELATIONSHIP QUESTIONS\n';
        csvOutput += 'FromTable,FromColumn,ToTable,ToColumn,Question,Type,Priority,Options,Response\n';
        csvData.relationshipQuestions.forEach(q => {
          csvOutput += `"${q.fromTable}","${q.fromColumn}","${q.toTable}","${q.toColumn}","${q.question}","${q.questionType}","${q.priority}","${q.options || ''}","${q.response || ''}"\n`;
        });
      }
      
      res.send(csvOutput);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "CSV export failed" });
    }
  });

  // Database cleanup routes
  app.post('/api/databases/:id/cleanup-duplicates', async (req, res) => {
    try {
      const databaseId = req.params.id;
      const deletedCount = await storage.deduplicateTablesForDatabase(databaseId);
      res.json({ 
        success: true, 
        deletedTables: deletedCount,
        message: `Removed ${deletedCount} duplicate tables` 
      });
    } catch (error) {
      console.error('Error cleaning up duplicates:', error);
      res.status(500).json({ error: 'Failed to cleanup duplicates' });
    }
  });

  // Agent Persona routes
  app.post("/api/agent-personas", async (req, res) => {
    try {
      const personaData = insertAgentPersonaSchema.parse(req.body);
      const persona = await storage.createAgentPersona(personaData);
      res.json(persona);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid request" });
    }
  });

  app.get("/api/databases/:id/personas", async (req, res) => {
    try {
      const { id } = req.params;
      const personas = await storage.getPersonasByDatabaseId(id);
      res.json(personas);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to fetch personas" });
    }
  });

  // Analysis Jobs routes
  app.get("/api/databases/:id/jobs", async (req, res) => {
    try {
      const { id } = req.params;
      const jobs = await storage.getAnalysisJobs(id);
      res.json(jobs);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to fetch jobs" });
    }
  });

  app.get("/api/jobs/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const jobs = await storage.getAnalysisJobs(id);
      const job = jobs.find(j => j.id === id);
      
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }
      
      res.json(job);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to fetch job" });
    }
  });

  // Cancel a running analysis job
  app.post("/api/jobs/:id/cancel", async (req, res) => {
    try {
      const { id } = req.params;
      
      const result = await storage.updateAnalysisJob(id, {
        status: "cancelled",
        error: "Job cancelled by user",
        completedAt: new Date()
      });
      
      console.log(`Job ${id} cancelled by user`);
      res.json({ success: true, message: "Job cancelled successfully" });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to cancel job" });
    }
  });

  // Neo4j Knowledge Graph routes
  app.post("/api/databases/:id/build-graph", async (req, res) => {
    try {
      const { id } = req.params;
      const { neo4jConnectionId } = req.body;
      
      if (!neo4jConnectionId) {
        return res.status(400).json({ error: "Neo4j connection ID is required" });
      }
      
      const neo4jConnection = await storage.getConnection(neo4jConnectionId);
      if (!neo4jConnection) {
        return res.status(404).json({ error: "Neo4j connection not found" });
      }
      
      // Connect to Neo4j
      const connected = await neo4jService.connect(neo4jConnection.config as any);
      if (!connected) {
        return res.status(500).json({ error: "Failed to connect to Neo4j" });
      }
      
      try {
        // Create namespace for this database
        const namespace = `database_${id}`;
        await neo4jService.createNamespace(namespace);
        
        // Get personas and their tables
        const personas = await storage.getPersonasByDatabaseId(id);
        
        for (const persona of personas) {
          // Create Agent Persona node
          await neo4jService.createAgentPersona({
            id: persona.id,
            name: persona.name,
            description: persona.description,
            keywords: Array.isArray(persona.keywords) ? persona.keywords as string[] : [],
            namespace
          });
          
          // Get tables for this persona (for now, just get all selected tables)
          const tables = await storage.getSelectedTables(id);
          
          for (const table of tables) {
            // Create Table node
            await neo4jService.createTableNode(persona.id, {
              id: table.id,
              name: table.name,
              schema: table.schema,
              rowCount: table.rowCount ?? undefined,
              columnCount: table.columnCount ?? undefined
            });
            
            // Get and create Column nodes
            const columns = await storage.getColumnsByTableId(table.id);
            
            for (const column of columns) {
              await neo4jService.createColumnNode(table.id, {
                id: column.id,
                name: column.name,
                dataType: column.dataType,
                description: column.aiDescription ?? undefined,
                isNullable: column.isNullable ?? false,
                cardinality: column.cardinality ?? undefined,
                nullPercentage: parseFloat(column.nullPercentage || '0')
              });
              
              // Create Value nodes for low-cardinality columns
              if (column.cardinality && column.cardinality <= 100 && column.distinctValues) {
                try {
                  const values = JSON.parse(String(column.distinctValues));
                  for (const value of values) {
                    await neo4jService.createValueNode(column.id, {
                      id: `${column.id}_${value}`,
                      value: String(value)
                    });
                  }
                } catch (e) {
                  // Ignore JSON parse errors
                }
              }
            }
          }
        }
        
        // Create relationships based on foreign keys
        const allTables = await storage.getTablesByDatabaseId(id);
        for (const table of allTables) {
          const foreignKeys = await storage.getForeignKeysByTableId(table.id);
          
          for (const fk of foreignKeys) {
            if (fk.isValidated) {
              await neo4jService.createRelationship({
                fromId: fk.fromColumnId,
                toId: fk.toColumnId,
                type: 'REFERENCES',
                properties: {
                  confidence: parseFloat(fk.confidence || '1.0'),
                  validated: true
                }
              });
            }
          }
        }
        
        res.json({ success: true, namespace });
        
      } finally {
        await neo4jService.disconnect();
      }
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Graph building failed" });
    }
  });

  app.get("/api/databases/:id/graph-stats", async (req, res) => {
    try {
      const { id } = req.params;
      const { neo4jConnectionId } = req.query;
      
      if (!neo4jConnectionId) {
        return res.status(400).json({ error: "Neo4j connection ID is required" });
      }
      
      const neo4jConnection = await storage.getConnection(neo4jConnectionId as string);
      if (!neo4jConnection) {
        return res.status(404).json({ error: "Neo4j connection not found" });
      }
      
      const connected = await neo4jService.connect(neo4jConnection.config as any);
      if (!connected) {
        return res.status(500).json({ error: "Failed to connect to Neo4j" });
      }
      
      try {
        const namespace = `database_${id}`;
        const stats = await neo4jService.getGraphStatistics(namespace);
        res.json(stats);
      } finally {
        await neo4jService.disconnect();
      }
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to get graph stats" });
    }
  });

  // Add API 404 handler to prevent HTML confusion for API misses
  app.use('/api', (req, res) => {
    res.status(404).json({ 
      error: 'API endpoint not found', 
      path: req.path, 
      method: req.method 
    });
  });

  const httpServer = createServer(app);
  return httpServer;
}
