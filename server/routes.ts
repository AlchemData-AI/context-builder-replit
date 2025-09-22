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
              if (column.cardinality && column.cardinality <= 50 && column.distinctValues) {
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

  const httpServer = createServer(app);
  return httpServer;
}
