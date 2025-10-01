import type { Express } from "express";
import { createServer, type Server } from "http";
import multer from 'multer';
import { storage } from "./storage";
import { postgresAnalyzer } from "./services/postgres-analyzer";
import { neo4jService } from "./services/neo4j-service";
import { geminiService } from "./services/gemini";
import { schemaAnalyzer } from "./services/schema-analyzer";
import { statisticalAnalyzer } from "./services/statistical-analyzer";
import { semanticAnalyzer } from "./services/semantic-analyzer";
import { smeInterviewService } from "./services/sme-interview";
import { neo4jBackfillService } from "./services/neo4j-backfill";
import { neo4jDeduplicationService } from "./services/neo4j-deduplication";
import { EnvironmentService } from "./services/environment-service";
import { insertConnectionSchema, insertDatabaseSchema, insertTableSchema, insertAgentPersonaSchema } from "@shared/schema";
import { z } from "zod";

// Helper function to create default personas when none exist
async function createDefaultPersonas(databaseId: string) {
  const personas = [];
  
  try {
    // Get database info
    const database = await storage.getDatabase(databaseId);
    if (!database) return [];
    
    // Get selected tables
    const tables = await storage.getSelectedTables(databaseId);
    if (tables.length === 0) return [];
    
    // Get SME responses for context
    const smeQuestions = await storage.getQuestionsByDatabaseId(databaseId);
    const answeredQuestions = smeQuestions.filter(q => q.isAnswered && q.response);
    
    // Create a default "Database Analyst" persona
    const personaData = {
      name: "Database Analyst",
      description: `Expert analyst for ${database.name} database with ${tables.length} tables. ` + 
                  (answeredQuestions.length > 0 
                    ? `Validated through ${answeredQuestions.length} SME responses covering data relationships and business logic.`
                    : "Specialized in database schema analysis and data relationship discovery."),
      keywords: ["database", "analysis", "schema", "relationships", ...tables.map(t => t.name).slice(0, 5)],
      databaseId
    };
    console.log('Creating default persona with data:', JSON.stringify(personaData, null, 2));
    
    const defaultPersona = await storage.createAgentPersona(personaData);
    
    personas.push(defaultPersona);
    
    // If we have many tables (>10), create domain-specific personas
    if (tables.length > 10) {
      // Group tables by common prefixes or keywords
      const tableGroups = groupTablesByDomain(tables);
      
      for (const [domain, domainTables] of Object.entries(tableGroups)) {
        if (domainTables.length >= 3) { // Only create personas for significant domains
          const domainPersona = await storage.createAgentPersona({
            name: `${domain.charAt(0).toUpperCase() + domain.slice(1)} Specialist`,
            description: `Domain expert specializing in ${domain}-related data within ${database.name}. ` +
                        `Manages ${domainTables.length} tables including ${domainTables.slice(0, 3).map(t => t.name).join(', ')}.`,
            keywords: [domain, "specialist", ...domainTables.map(t => t.name).slice(0, 3)],
            databaseId
          });
          personas.push(domainPersona);
        }
      }
    }
    
    console.log(`Created ${personas.length} default personas for database ${databaseId}`);
    return personas;
    
  } catch (error) {
    console.error('Failed to create default personas:', error);
    return [];
  }
}

// Helper function to group tables by domain based on naming patterns
function groupTablesByDomain(tables: any[]) {
  const domains: Record<string, any[]> = {};
  
  for (const table of tables) {
    const tableName = table.name.toLowerCase();
    
    // Extract domain from common prefixes or keywords
    let domain = 'general';
    
    if (tableName.includes('user') || tableName.includes('account') || tableName.includes('profile')) {
      domain = 'user';
    } else if (tableName.includes('order') || tableName.includes('purchase') || tableName.includes('payment')) {
      domain = 'commerce';
    } else if (tableName.includes('product') || tableName.includes('inventory') || tableName.includes('catalog')) {
      domain = 'product';
    } else if (tableName.includes('log') || tableName.includes('audit') || tableName.includes('event')) {
      domain = 'audit';
    } else if (tableName.includes('config') || tableName.includes('setting') || tableName.includes('param')) {
      domain = 'configuration';
    }
    
    if (!domains[domain]) domains[domain] = [];
    domains[domain].push(table);
  }
  
  return domains;
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Initialize environment service for automatic Neo4j connection selection
  const environmentService = EnvironmentService.getInstance();
  
  // Configure multer for CSV file uploads
  const csvUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 10 * 1024 * 1024, // 10MB limit
    },
    fileFilter: (req, file, cb) => {
      if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
        cb(null, true);
      } else {
        cb(new Error('Only CSV files are allowed'));
      }
    }
  });

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

  // Get available schemas for a PostgreSQL connection
  app.get("/api/connections/:id/schemas", async (req, res) => {
    try {
      const { id } = req.params;
      const connection = await storage.getConnection(id);
      if (!connection) {
        return res.status(404).json({ error: "Connection not found" });
      }
      
      if (connection.type !== 'postgresql') {
        return res.status(400).json({ error: "Schema discovery only supported for PostgreSQL connections" });
      }

      const config = connection.config as any;
      const connected = await postgresAnalyzer.connect(config);
      if (!connected) {
        return res.status(500).json({ error: "Failed to connect to PostgreSQL" });
      }

      try {
        const schemas = await postgresAnalyzer.getSchemas();
        res.json({ schemas });
      } finally {
        // Always disconnect to prevent connection leaks
        await postgresAnalyzer.disconnect();
      }
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to fetch schemas" });
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
          
          // Generate or reuse table description (checks Neo4j first to save LLM calls)
          const schema = `CREATE TABLE ${table.schema}.${table.name} (\n${columns.map(c => `  ${c.name} ${c.dataType}`).join(',\n')}\n);`;
          const tableDesc = await geminiService.generateOrReuseTableDescription(
            table.name, 
            schema, 
            sampleData,
            id, // Keep as string for canonical key consistency
            table.schema,
            req.query.forceRegenerate === 'true' // Support force regeneration via query param
          );
          
          // Generate or reuse column descriptions (checks Neo4j first to save LLM calls)
          const columnData = columns.map(c => ({
            name: c.name,
            dataType: c.dataType,
            sampleValues: sampleData.map(row => row[c.name]).filter(v => v != null).slice(0, 10),
            cardinality: c.cardinality ?? undefined,
            nullPercentage: parseFloat(c.nullPercentage || '0'),
            databaseId: id, // Keep as string for canonical key consistency
            tableSchema: table.schema
          }));
          
          const columnDescs = await geminiService.generateOrReuseColumnDescriptions(
            table.name, 
            columnData,
            req.query.forceRegenerate === 'true' // Support force regeneration via query param
          );
          
          // Log context reuse statistics
          const tableReused = tableDesc.wasReused ? 1 : 0;
          const columnsReused = columnDescs.filter(c => c.wasReused).length;
          if (tableReused > 0 || columnsReused > 0) {
            console.log(`💰 Cost savings for ${table.name}: ${tableReused} table + ${columnsReused}/${columnDescs.length} columns reused (${tableReused + columnsReused} LLM calls saved)`);
          }
          
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
      
      const batchSize = parseInt(process.env.AI_CONTEXT_BATCH_SIZE || '1');
      const job = await storage.createAnalysisJob({
        databaseId: id,
        type: "ai_context",
        status: "running",
        progress: 0,
        result: null,
        error: null,
        startedAt: new Date(),
        completedAt: null,
        totalUnits: tables.length,
        completedUnits: 0,
        batchSize: batchSize,
        processedTableIds: [],
        nextIndex: 0,
        batchIndex: 0
      });

      // Send response immediately to avoid request timeout
      res.json(job);

      // Process tables asynchronously - use setImmediate to ensure it runs in next tick
      console.log(`Starting async processing for job ${job.id} with ${tables.length} tables`);
      setImmediate(() => {
        processTablesAsync(job.id, tables, storage, schemaAnalyzer, statisticalAnalyzer, geminiService)
          .catch(error => {
            console.error(`Async processing failed for job ${job.id}:`, error);
            // Update job status to failed
            storage.updateAnalysisJob(job.id, {
              status: "failed",
              error: error instanceof Error ? error.message : "Async processing failed",
              completedAt: new Date()
            }).catch(dbError => {
              console.error(`Failed to update job status after async error:`, dbError);
            });
          });
      });
      
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Context and question generation failed" });
    }
  });

  // Batched async function to process tables in background with memory efficiency
  async function processTablesAsync(
    jobId: string, 
    tables: any[], 
    storage: any, 
    schemaAnalyzer: any, 
    statisticalAnalyzer: any, 
    geminiService: any
  ) {
    console.log(`[Job ${jobId}] Starting batched processing for ${tables.length} tables`);
    
    try {
      // Get current job state to check if this is a resume operation
      const job = await storage.getAnalysisJob(jobId);
      if (!job) {
        console.error(`[Job ${jobId}] Job not found - cannot process`);
        return;
      }

      // Get processed table IDs to support resumption
      const processedTableIds = Array.isArray(job.processedTableIds) ? job.processedTableIds : [];
      const startIndex = job.nextIndex || 0;
      const batchSize = job.batchSize || 1;
      
      console.log(`[Job ${jobId}] Resuming from index ${startIndex}, batch size ${batchSize}, already processed ${processedTableIds.length} tables`);

      // Process tables in batches starting from nextIndex
      for (let batchStart = startIndex; batchStart < tables.length; batchStart += batchSize) {
        const batchEnd = Math.min(batchStart + batchSize, tables.length);
        const currentBatch = tables.slice(batchStart, batchEnd);
        const currentBatchIndex = Math.floor(batchStart / batchSize);
        
        console.log(`[Job ${jobId}] Processing batch ${currentBatchIndex + 1}, tables ${batchStart + 1}-${batchEnd} of ${tables.length}`);

        // Process each table in the current batch
        for (let i = 0; i < currentBatch.length; i++) {
          const table = currentBatch[i];
          const tableIndex = batchStart + i;
          
          console.log(`[Job ${jobId}] Starting table ${tableIndex + 1}/${tables.length}: ${table.name} (ID: ${table.id})`);
          
          // Skip if already processed (for resume scenarios)
          if (processedTableIds.includes(table.id)) {
            console.log(`[Job ${jobId}] Skipping already processed table: ${table.name}`);
            continue;
          }

          try {
            console.log(`[Job ${jobId}] About to call processSingleTable for ${table.name}...`);
            
            // Process single table with memory-efficient approach
            const questionsGenerated = await processSingleTable(
              table, storage, schemaAnalyzer, statisticalAnalyzer, geminiService, jobId
            );

            console.log(`[Job ${jobId}] processSingleTable completed for ${table.name}, generated ${questionsGenerated} questions`);

            // Update job state after each successful table (CRITICAL for persistence)
            processedTableIds.push(table.id);
            const completedUnits = processedTableIds.length;
            const progress = Math.round((completedUnits / tables.length) * 100);

            console.log(`[Job ${jobId}] About to update job state: completedUnits=${completedUnits}, nextIndex=${tableIndex + 1}`);

            await storage.updateAnalysisJob(jobId, {
              completedUnits,
              progress,
              processedTableIds: [...processedTableIds], // Create new array for JSON serialization
              nextIndex: tableIndex + 1,
              batchIndex: currentBatchIndex,
              lastError: null // Clear any previous errors on success
            });

            console.log(`[Job ${jobId}] Table ${table.name} completed. Progress: ${completedUnits}/${tables.length} (${progress}%)`);
            console.log(`[Job ${jobId}] Job state updated: nextIndex=${tableIndex + 1}, completedUnits=${completedUnits}`);
            console.log(`[Job ${jobId}] ProcessedTableIds now contains: ${JSON.stringify(processedTableIds)}`);

          } catch (error) {
            console.error(`[Job ${jobId}] Failed to process table ${table.name}:`, error);
            
            // Store failed table entry but continue processing (CRITICAL: don't abort loop)
            try {
              await storage.upsertContextForTable({
                databaseId: job.databaseId,
                tableId: table.id,
                tableDesc: null,
                columnDescs: null,
                questionsGenerated: 0
              });
            } catch (storeError) {
              console.error(`[Job ${jobId}] Failed to store failed table context:`, storeError);
            }

            // CRITICAL: Still update job state to continue processing
            processedTableIds.push(table.id); // Mark as processed even if failed
            const completedUnits = processedTableIds.length;
            const progress = Math.round((completedUnits / tables.length) * 100);

            await storage.updateAnalysisJob(jobId, {
              completedUnits,
              progress,
              processedTableIds: [...processedTableIds],
              nextIndex: tableIndex + 1,
              batchIndex: currentBatchIndex,
              lastError: error instanceof Error ? error.message : "Unknown error"
            });

            console.log(`[Job ${jobId}] Table ${table.name} failed but job state updated to continue. Progress: ${completedUnits}/${tables.length} (${progress}%)`);
            // Continue to next table instead of aborting entire job
          }
        }

        // Small delay between batches to allow memory cleanup
        if (batchEnd < tables.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      // Mark job as completed
      await storage.updateAnalysisJob(jobId, {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
        result: JSON.stringify({ 
          totalTables: tables.length, 
          processedTables: processedTableIds.length,
          completedAt: new Date().toISOString()
        })
      });

      console.log(`[Job ${jobId}] Completed successfully! Processed ${processedTableIds.length}/${tables.length} tables`);
      
    } catch (error) {
      console.error(`[Job ${jobId}] Critical failure:`, error);
      await storage.updateAnalysisJob(jobId, {
        status: "failed",
        error: error instanceof Error ? error.message : "Critical error during batch processing",
        completedAt: new Date()
      });
    }
  }

  // Helper function to process a single table efficiently
  async function processSingleTable(
    table: any,
    storage: any,
    schemaAnalyzer: any,
    statisticalAnalyzer: any,
    geminiService: any,
    jobId: string
  ): Promise<number> {
    console.log(`[Job ${jobId}] Starting processSingleTable for ${table.name}...`);
    
    let sampleData: any[];
    let columns: any[];
    let statisticalResults: any;
    
    try {
      // Get sample data and columns with enhanced error handling
      console.log(`[Job ${jobId}] Attempting to get sample data for table ${table.name}...`);
      sampleData = await schemaAnalyzer.getSampleData(table.id);
      console.log(`[Job ${jobId}] Sample data retrieved for ${table.name}: ${sampleData.length} rows`);
      
      console.log(`[Job ${jobId}] Getting columns for table ${table.name}...`);
      columns = await storage.getColumnsByTableId(table.id);
      console.log(`[Job ${jobId}] Columns retrieved for ${table.name}: ${columns.length} columns`);
      
      // Get statistical analysis for richer context
      console.log(`[Job ${jobId}] Running statistical analysis for table ${table.name}...`);
      statisticalResults = await statisticalAnalyzer.analyzeTable(table.id);
      console.log(`[Job ${jobId}] Statistical analysis completed for ${table.name}`);
    } catch (dataError) {
      // Handle database sampling/analysis errors (e.g., table doesn't exist in DB)
      const errorMessage = `Failed to sample data or analyze table '${table.name}': ${dataError instanceof Error ? dataError.message : 'Unknown error'}`;
      console.error(`[Job ${jobId}] ${errorMessage}`);
      
      // Store error context but don't generate questions
      await storage.upsertContextForTable({
        databaseId: table.databaseId,
        tableId: table.id,
        tableDesc: { error: errorMessage, tableName: table.name },
        columnDescs: [],
        questionsGenerated: 0
      });
      
      // Throw error with clear context to be caught by parent
      throw new Error(`Table '${table.name}' sampling failed: ${dataError instanceof Error ? dataError.message : 'Unknown database error'}`);
    }
    
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
    
    // Use combined Gemini service method
    console.log(`[Job ${jobId}] Calling Gemini for table: ${table.name}`);
    const contextAndQuestions = await geminiService.generateContextAndQuestions(
      table.name,
      schema,
      sampleData,
      columnData,
      statisticalResults
    );
    console.log(`[Job ${jobId}] Gemini response for ${table.name}: ${contextAndQuestions.columns?.length || 0} columns processed`);
    
    let totalQuestionsGenerated = 0;

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
        totalQuestionsGenerated++;
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
        totalQuestionsGenerated++;
      }
    }

    // Process enum values for low cardinality columns
    console.log(`[Job ${jobId}] Processing enum values for table ${table.name}...`);
    const enumColumnsProcessed = await processEnumValuesForTable(table, columns, storage, geminiService, jobId);
    console.log(`[Job ${jobId}] Processed enum values for ${enumColumnsProcessed} columns in table ${table.name}`);

    // Store context for this table using new ContextItem storage
    await storage.upsertContextForTable({
      databaseId: table.databaseId,
      tableId: table.id,
      tableDesc: contextAndQuestions.table || null,
      columnDescs: contextAndQuestions.columns || null,
      questionsGenerated: totalQuestionsGenerated
    });

    console.log(`[Job ${jobId}] Stored context for table ${table.name}: ${totalQuestionsGenerated} questions generated, ${enumColumnsProcessed} enum columns processed`);
    
    return totalQuestionsGenerated;
  }

  // Helper function to process enum values for a table
  async function processEnumValuesForTable(
    table: any,
    columns: any[],
    storage: any,
    geminiService: any,
    jobId: string
  ): Promise<number> {
    let enumColumnsProcessed = 0;

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

    // Find enum-like columns (low cardinality with distinct values)
    const enumColumns = columns.filter(c => 
      c.cardinality != null && 
      c.cardinality >= 2 && 
      c.cardinality < 100 && // Consider columns with 2-99 distinct values as enum-like
      c.distinctValues != null
    );

    console.log(`[Job ${jobId}] Found ${enumColumns.length} enum-like columns in table ${table.name}`);

    for (const column of enumColumns) {
      try {
        let distinctValues = safeParseArray(column.distinctValues);
        
        if (distinctValues.length === 0) {
          console.log(`[Job ${jobId}] No distinct values found for column ${column.name}, skipping`);
          continue;
        }

        console.log(`[Job ${jobId}] Processing ${distinctValues.length} enum values for column ${column.name}`);

        // Check existing enum values to create only missing ones
        const existingEnumValues = await storage.getEnumValuesByColumnId(column.id);
        const existingValues = new Set(existingEnumValues.map((ev: any) => ev.value));
        const newValues = distinctValues.filter(v => !existingValues.has(String(v)));
        
        if (newValues.length === 0) {
          console.log(`[Job ${jobId}] All enum values already exist for column ${column.name}, skipping`);
          continue;
        }
        
        console.log(`[Job ${jobId}] Found ${newValues.length} new enum values to process for column ${column.name} (${existingEnumValues.length} already exist)`);
        distinctValues = newValues; // Process only new values

        // Generate AI context for enum values
        const enumContexts = await geminiService.generateEnumValueContext(
          table.name,
          column.name,
          column.dataType,
          distinctValues.map(v => String(v)),
          column.aiDescription
        );

        console.log(`[Job ${jobId}] Generated context for ${enumContexts.length} enum values in column ${column.name}`);

        // Store each enum value with its context
        for (const enumContext of enumContexts) {
          try {
            const createdEnumValue = await storage.createEnumValue({
              columnId: column.id,
              value: enumContext.value,
              frequency: null, // We don't have frequency data from distinctValues
              aiContext: enumContext.context,
              aiHypothesis: enumContext.hypothesis
            });

            // Generate SME questions for this enum value
            await storage.createSmeQuestion({
              tableId: table.id,
              columnId: column.id,
              enumValueId: createdEnumValue.id, // Link to the created enum value
              questionType: 'enum_value',
              questionText: `In column '${column.name}', we found the value '${enumContext.value}'. AI suggests: ${enumContext.hypothesis}. Do you agree with this interpretation, or would you provide a different business definition?`,
              priority: 'medium'
            });
            
          } catch (enumError) {
            console.error(`[Job ${jobId}] Failed to store enum value ${enumContext.value} for column ${column.name}:`, enumError);
          }
        }

        enumColumnsProcessed++;
        console.log(`[Job ${jobId}] Completed processing enum values for column ${column.name}`);

      } catch (columnError) {
        console.error(`[Job ${jobId}] Failed to process enum values for column ${column.name}:`, columnError);
      }
    }

    return enumColumnsProcessed;
  }

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
      
      // Get database info
      const database = await storage.getDatabase(id);
      if (!database) {
        return res.status(404).json({ error: "Database not found" });
      }
      
      // Helper function to safely escape CSV values
      const safeCSV = (value: any) => {
        let str = '';
        if (value === null || value === undefined) {
          str = '';
        } else if (typeof value === 'string') {
          str = value;
        } else if (typeof value === 'object') {
          str = JSON.stringify(value);
        } else {
          str = String(value);
        }
        
        // Escape quotes and wrap in quotes for CSV
        const escaped = str.replace(/"/g, '""');
        
        // Prevent CSV injection by prefixing formula characters
        if (escaped.match(/^[=+\-@]/)) {
          return `"'${escaped}"`;
        }
        
        return `"${escaped}"`;
      };
      
      // Gather only selected tables
      const tables = await storage.getSelectedTables(id);
      const contextItems = await storage.getContextsByDatabaseId(id);
      const allQuestions = await storage.getQuestionsByDatabaseId(id);
      
      // Create context lookup
      const contextByTableId = new Map();
      contextItems.forEach(ctx => {
        contextByTableId.set(ctx.tableId, ctx);
      });
      
      // Group questions by table and column
      const questionsByTable = new Map();
      const questionsByColumn = new Map();
      
      allQuestions.forEach(q => {
        if (q.tableId && !q.columnId) {
          // Table-level question
          if (!questionsByTable.has(q.tableId)) {
            questionsByTable.set(q.tableId, []);
          }
          questionsByTable.get(q.tableId).push(q);
        } else if (q.columnId) {
          // Column-level question
          if (!questionsByColumn.has(q.columnId)) {
            questionsByColumn.set(q.columnId, []);
          }
          questionsByColumn.get(q.columnId).push(q);
        }
      });
      
      // Build CSV content
      let csvOutput = '';
      
      // SECTION 1: TABLE CONTEXT
      csvOutput += 'Section,Table,Schema,RowCount,ColumnCount,LastUpdated,AI_Table_Description,SME_Table_Questions_Count,SME_Table_Answered_Count,Related_Tables,Notes\n';
      
      for (const table of tables) {
        const context = contextByTableId.get(table.id);
        const tableQuestions = questionsByTable.get(table.id) || [];
        const answeredCount = tableQuestions.filter((q: any) => q.isAnswered).length;
        
        const aiTableDesc = context?.tableDesc ? 
          (typeof context.tableDesc === 'string' ? context.tableDesc : 
           (context.tableDesc as any)?.description || JSON.stringify(context.tableDesc)) : '';
        
        // Get foreign key relationships for this table
        const foreignKeys = await storage.getForeignKeysByTableId(table.id);
        const relatedTables = foreignKeys.map(fk => {
          return fk.fromTableId === table.id ? `→${fk.toTableId}` : `←${fk.fromTableId}`;
        }).join('; ');
        
        csvOutput += `${safeCSV('TABLE_CONTEXT')},${safeCSV(table.name)},${safeCSV(table.schema)},${safeCSV(table.rowCount)},${safeCSV(table.columnCount)},${safeCSV(table.lastUpdated?.toISOString())},${safeCSV(aiTableDesc)},${safeCSV(tableQuestions.length)},${safeCSV(answeredCount)},${safeCSV(relatedTables)},${safeCSV('')}\n`;
      }
      
      // Add blank line between sections
      csvOutput += '\n';
      
      // SECTION 2: COLUMN DETAILS
      csvOutput += 'Section,Table,Column,DataType,Nullable,Unique,Cardinality,NullPercent,Min,Max,DistinctSample,AI_Hypothesis,QuestionText,QuestionType,Options,Response,IsAnswered,Priority,FK_Role,FK_Target,Notes\n';
      
      for (const table of tables) {
        const columns = await storage.getColumnsByTableId(table.id);
        const context = contextByTableId.get(table.id);
        
        for (const column of columns) {
          const columnQuestions = questionsByColumn.get(column.id) || [];
          
          // Get AI hypothesis from context or column
          let aiHypothesis = column.aiDescription || '';
          if (context?.columnDescs) {
            const columnDesc = Array.isArray(context.columnDescs) ? 
              context.columnDescs.find((desc: any) => desc.column_name === column.name) : 
              null;
            if (columnDesc && columnDesc.description) {
              aiHypothesis = columnDesc.description;
            }
          }
          
          // Get sample values (first few distinct values)
          let sampleValues = '';
          if (column.distinctValues && Array.isArray(column.distinctValues)) {
            sampleValues = column.distinctValues.slice(0, 5).join('; ');
          }
          
          // Find foreign key relationship for this column
          const allForeignKeys = await storage.getForeignKeysByTableId(table.id);
          const columnFK = allForeignKeys.find(fk => 
            fk.fromColumnId === column.id || fk.toColumnId === column.id
          );
          
          let fkRole = '';
          let fkTarget = '';
          if (columnFK) {
            if (columnFK.fromColumnId === column.id) {
              fkRole = 'FROM';
              fkTarget = `${columnFK.toTableId}.${columnFK.toColumnId}`;
            } else {
              fkRole = 'TO';  
              fkTarget = `${columnFK.fromTableId}.${columnFK.fromColumnId}`;
            }
          }
          
          // If there are questions for this column, create one row per question
          if (columnQuestions.length > 0) {
            for (const question of columnQuestions) {
              csvOutput += `${safeCSV('COLUMN_DETAILS')},${safeCSV(table.name)},${safeCSV(column.name)},${safeCSV(column.dataType)},${safeCSV(column.isNullable)},${safeCSV(column.isUnique)},${safeCSV(column.cardinality)},${safeCSV(column.nullPercentage)},${safeCSV(column.minValue)},${safeCSV(column.maxValue)},${safeCSV(sampleValues)},${safeCSV(aiHypothesis)},${safeCSV(question.questionText)},${safeCSV(question.questionType)},${safeCSV(question.options)},${safeCSV(question.response)},${safeCSV(question.isAnswered ? 'Yes' : 'No')},${safeCSV(question.priority)},${safeCSV(fkRole)},${safeCSV(fkTarget)},${safeCSV('')}\n`;
            }
          } else {
            // If no questions, create one row with empty question fields
            csvOutput += `${safeCSV('COLUMN_DETAILS')},${safeCSV(table.name)},${safeCSV(column.name)},${safeCSV(column.dataType)},${safeCSV(column.isNullable)},${safeCSV(column.isUnique)},${safeCSV(column.cardinality)},${safeCSV(column.nullPercentage)},${safeCSV(column.minValue)},${safeCSV(column.maxValue)},${safeCSV(sampleValues)},${safeCSV(aiHypothesis)},${safeCSV('')},${safeCSV('')},${safeCSV('')},${safeCSV('')},${safeCSV('No')},${safeCSV('')},${safeCSV(fkRole)},${safeCSV(fkTarget)},${safeCSV('')}\n`;
          }
        }
      }
      
      // Add blank line between sections
      csvOutput += '\n';
      
      // SECTION 3: ENUM CONTEXT
      csvOutput += 'Section,Table,Column,EnumValue,AI_Context,AI_Hypothesis,QuestionText,QuestionType,Options,Response,IsAnswered,Priority,Notes\n';
      
      // Get all enum values for selected tables
      const allEnumValues = await storage.getEnumValuesByDatabaseId(id);
      
      // Group enum questions by enum value ID
      const enumQuestionsByValueId = new Map();
      allQuestions.filter((q) => q.questionType === 'enum_value' && q.enumValueId).forEach((q) => {
        if (!enumQuestionsByValueId.has(q.enumValueId)) {
          enumQuestionsByValueId.set(q.enumValueId, []);
        }
        enumQuestionsByValueId.get(q.enumValueId).push(q);
      });
      
      for (const enumValue of allEnumValues) {
        // Find the table and column names for this enum value
        const column = await storage.getColumnById(enumValue.columnId);
        if (!column) continue;
        
        const table = tables.find(t => t.id === column.tableId);
        if (!table) continue;
        
        const enumQuestions = enumQuestionsByValueId.get(enumValue.id) || [];
        
        // If there are questions for this enum value, create one row per question
        if (enumQuestions.length > 0) {
          for (const question of enumQuestions) {
            csvOutput += `${safeCSV('ENUM_CONTEXT')},${safeCSV(table.name)},${safeCSV(column.name)},${safeCSV(enumValue.value)},${safeCSV(enumValue.aiContext)},${safeCSV(enumValue.aiHypothesis)},${safeCSV(question.questionText)},${safeCSV(question.questionType)},${safeCSV(question.options)},${safeCSV(question.response)},${safeCSV(question.isAnswered ? 'Yes' : 'No')},${safeCSV(question.priority)},${safeCSV('')}\n`;
          }
        } else {
          // If no questions, create one row with empty question fields
          csvOutput += `${safeCSV('ENUM_CONTEXT')},${safeCSV(table.name)},${safeCSV(column.name)},${safeCSV(enumValue.value)},${safeCSV(enumValue.aiContext)},${safeCSV(enumValue.aiHypothesis)},${safeCSV('')},${safeCSV('')},${safeCSV('')},${safeCSV('')},${safeCSV('No')},${safeCSV('')},${safeCSV('')}\n`;
        }
      }
      
      // Set response headers
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${database.name}-sme-comprehensive-${new Date().toISOString().split('T')[0]}.csv"`);
      
      res.send(csvOutput);
      
    } catch (error) {
      console.error('Comprehensive CSV export error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : "CSV export failed" });
    }
  });

  // Updated knowledge graph building function that handles existing graphs
  async function updateEnhancedKnowledgeGraph(databaseId: string) {
    console.log('Updating enhanced knowledge graph for database:', databaseId);
    
    const namespace = `database_${databaseId}`;
    const namespaceExists = await neo4jService.checkNamespaceExists(namespace);
    
    if (namespaceExists) {
      console.log('Existing knowledge graph found, performing incremental updates');
      return await performIncrementalUpdate(databaseId, namespace);
    } else {
      console.log('No existing knowledge graph found, creating new graph');
      return await buildEnhancedKnowledgeGraph(databaseId);
    }
  }

  // Helper function to safely resolve table/column names to Neo4j node IDs
  async function resolveTableColumnToNodeIds(tableName: string, columnName: string, databaseId: string): Promise<{ tableId: string; columnId: string } | null> {
    try {
      const tables = await storage.getTablesByDatabaseId(databaseId);
      const table = tables.find(t => t.name.toLowerCase() === tableName.toLowerCase());
      if (!table) return null;
      
      const columns = await storage.getColumnsByTableId(table.id);
      const column = columns.find(c => c.name.toLowerCase() === columnName.toLowerCase());
      if (!column) return null;
      
      return { tableId: table.id, columnId: column.id };
    } catch (error) {
      console.error(`Failed to resolve ${tableName}.${columnName}:`, error);
      return null;
    }
  }

  // Helper function to extract and validate join information from SME responses
  async function extractJoinInfoFromSMEResponse(questionText: string, response: string, databaseId: string): Promise<{ fromId: string; toId: string; type: string } | null> {
    // Only process confirmed joins (yes responses)
    if (!response || !['yes', 'y', 'true', 'confirmed'].includes(response.toLowerCase().trim())) {
      return null;
    }
    
    // Look for table.column patterns in question text
    const tablePattern = /(\w+)\.(\w+).*?(?:relates?|joins?|connects?).*?(\w+)\.(\w+)/i;
    const match = questionText.match(tablePattern);
    
    if (!match) return null;
    
    const [, fromTable, fromColumn, toTable, toColumn] = match;
    
    // Resolve names to actual node IDs
    const fromNodeIds = await resolveTableColumnToNodeIds(fromTable, fromColumn, databaseId);
    const toNodeIds = await resolveTableColumnToNodeIds(toTable, toColumn, databaseId);
    
    if (!fromNodeIds || !toNodeIds) return null;
    
    return {
      fromId: fromNodeIds.columnId,
      toId: toNodeIds.columnId,
      type: 'SME_VALIDATED_JOIN' // Constrained to safe type
    };
  }

  // Incremental update function for existing knowledge graphs
  async function performIncrementalUpdate(databaseId: string, namespace: string) {
    console.log('Performing incremental knowledge graph update for database:', databaseId);
    
    // First, sync any missing personas from PostgreSQL to Neo4j
    console.log('Syncing personas from PostgreSQL to Neo4j...');
    const personas = await storage.getPersonasByDatabaseId(databaseId);
    console.log(`Found ${personas.length} personas in PostgreSQL`);
    
    for (const persona of personas) {
      console.log(`🔄 [SYNC] Creating persona in Neo4j: ${persona.name} (${persona.id})`);
      console.log('🔄 [SYNC] Persona data from PostgreSQL:', {
        id: persona.id,
        name: persona.name,
        description: persona.description,
        keywords: persona.keywords,
        databaseId: persona.databaseId
      });
      
      try {
        await neo4jService.createAgentPersona({
          id: persona.id,
          name: persona.name,
          description: persona.description,
          keywords: Array.isArray(persona.keywords) ? persona.keywords as string[] : [],
          namespace
        });
        console.log(`✅ [SYNC] Successfully synced persona: ${persona.name}`);
      } catch (error) {
        console.error(`❌ [SYNC] Failed to sync persona: ${persona.name}`, error);
        throw error;
      }
    }
    
    console.log(`🎉 [SYNC] Persona sync completed: ${personas.length} personas processed`);
    
    // Sync tables and their relationships to personas
    console.log('🔄 [SYNC] Creating table nodes and linking to personas...');
    const tables = await storage.getSelectedTables(databaseId);
    console.log(`Found ${tables.length} selected tables to link`);
    
    let tablesLinked = 0;
    
    for (const persona of personas) {
      for (const table of tables) {
        console.log(`🔗 [SYNC] Linking table ${table.name} to persona ${persona.name}`);
        await neo4jService.createTableNode(persona.id, {
          id: table.id,
          name: table.name,
          schema: table.schema,
          description: `Table containing ${table.columnCount || 0} columns with data analysis context`,
          rowCount: table.rowCount ?? undefined,
          columnCount: table.columnCount ?? undefined,
          databaseId: table.databaseId
        });
        tablesLinked++;
      }
    }
    
    // Create column nodes for all tables (outside persona loop for efficiency)
    console.log('🔄 [SYNC] Creating column nodes for all tables...');
    let columnsCreated = 0;
    let valuesCreated = 0;
    
    for (const table of tables) {
      const columns = await storage.getColumnsByTableId(table.id);
      console.log(`🔗 [SYNC] Creating ${columns.length} column nodes for table ${table.name}`);
      
      for (const column of columns) {
        await neo4jService.createColumnNode(table.id, {
          id: column.id,
          name: column.name,
          dataType: column.dataType,
          description: column.aiDescription || `Column ${column.name} in table ${table.name}`,
          isNullable: column.isNullable || false,
          cardinality: typeof column.cardinality === 'number' ? column.cardinality : (parseInt(String(column.cardinality)) || 0),
          nullPercentage: typeof column.nullPercentage === 'number' ? column.nullPercentage : (parseFloat(String(column.nullPercentage)) || 0),
          databaseId: table.databaseId,
          tableSchema: table.schema,
          tableName: table.name
        });
        columnsCreated++;
        
        // Create Value nodes for low-cardinality columns with AI context from enum values
        console.log(`[DEBUG] [SYNC] Column ${column.name}: cardinality=${column.cardinality}, hasDistinctValues=${!!column.distinctValues}`);
        if (column.cardinality && column.cardinality < 100 && column.distinctValues) {
          console.log(`[DEBUG] ✓ [SYNC] Column ${column.name} PASSED condition check - will create value nodes`);
          // Get enum values with AI context if they exist
          const enumValues = await storage.getEnumValuesByColumnId(column.id);
          const enumValueMap = new Map();
          enumValues.forEach((ev: any) => {
            enumValueMap.set(ev.value, { aiContext: ev.aiContext, aiHypothesis: ev.aiHypothesis });
          });
          
          let values = [];
          let valueNodesCreated = 0;
          let valueNodesWithContext = 0;
          
          // Try multiple parsing strategies for distinctValues
          try {
            values = JSON.parse(String(column.distinctValues));
          } catch (jsonError) {
            // Fallback: try CSV parsing for comma-separated values
            try {
              values = String(column.distinctValues).split(',').map(v => v.trim()).filter(v => v.length > 0);
              console.log(`Used CSV fallback for column ${column.name}: ${values.length} values`);
            } catch (csvError) {
              // Final fallback: semicolon or newline separated
              values = String(column.distinctValues).split(/[;\n]/).map(v => v.trim()).filter(v => v.length > 0);
              console.log(`Used delimiter fallback for column ${column.name}: ${values.length} values`);
            }
          }
          
          if (!Array.isArray(values) || values.length === 0) {
            console.warn(`No parseable values found for column ${column.name}, skipping value nodes`);
          } else {
            for (const value of values) {
              const enumData = enumValueMap.get(String(value));
              await neo4jService.createValueNode(column.id, {
                id: `${column.id}_${value}`,
                value: String(value),
                aiContext: enumData?.aiContext,
                aiHypothesis: enumData?.aiHypothesis
              });
              valueNodesCreated++;
              if (enumData?.aiContext || enumData?.aiHypothesis) {
                valueNodesWithContext++;
              }
            }
            
            valuesCreated += valueNodesCreated;
            console.log(`Created ${valueNodesCreated} value nodes for column ${column.name} (${valueNodesWithContext} with AI context)`);
          }
        }
      }
    }
    
    console.log(`✅ [SYNC] Incremental update completed: ${tablesLinked} table links, ${columnsCreated} columns, and ${valuesCreated} value nodes created for ${personas.length} personas`);
    
    let stats = await neo4jService.getNamespaceStatistics(namespace);
    
    // Get SME questions and answers
    const smeQuestions = await storage.getQuestionsByDatabaseId(databaseId);
    const newlyAnsweredQuestions = smeQuestions.filter(q => 
      q.isAnswered && q.response && q.questionType === 'relationship'
    );
    
    // Update column descriptions with SME feedback integration
    const answeredColumnQuestions = smeQuestions.filter(q => 
      q.isAnswered && q.response && q.columnId && (q.questionType === 'column' || q.questionType === 'enum_value')
    );
    
    // Group questions by column ID
    const questionsByColumn = new Map();
    for (const question of answeredColumnQuestions) {
      if (!question.columnId) continue;
      
      if (!questionsByColumn.has(question.columnId)) {
        questionsByColumn.set(question.columnId, []);
      }
      questionsByColumn.get(question.columnId)!.push({
        questionText: question.questionText,
        response: question.response!,
        questionType: question.questionType
      });
    }
    
    // Process each column with SME feedback
    for (const [columnId, columnQuestions] of Array.from(questionsByColumn.entries())) {
      try {
        const column = await storage.getColumnById(columnId);
        if (!column || !column.aiDescription) continue;
        
        const table = await storage.getTable(column.tableId);
        if (!table) continue;
        
        console.log(`Merging SME feedback for column ${column.name} with ${columnQuestions.length} responses`);
        
        // Use Gemini to merge AI description with SME feedback
        const updatedDescription = await geminiService.mergeColumnContextWithSMEFeedback(
          column.name,
          table.name,
          column.aiDescription,
          columnQuestions
        );
        
        // Update the column description in storage
        await storage.updateColumnStats(column.id, {
          aiDescription: updatedDescription
        });
        
        // Update column description in Neo4j
        await neo4jService.updateColumnDescription(column.id, updatedDescription);
        
      } catch (error) {
        console.error(`Failed to update column description with SME feedback:`, error);
      }
    }
    
    // Add new SME-validated relationships from Q&A responses
    let relationshipsProcessed = 0;
    for (const question of newlyAnsweredQuestions) {
      try {
        // Process validated join suggestions from SME responses
        const joinInfo = await extractJoinInfoFromSMEResponse(question.questionText, question.response || '', databaseId);
        if (joinInfo) {
          // Create SME-validated relationship in Neo4j
          await neo4jService.createRelationship({
            fromId: joinInfo.fromId,
            toId: joinInfo.toId,
            type: joinInfo.type,
            properties: {
              smeResponse: question.response,
              confidence: 0.9, // High confidence since SME validated
              validatedAt: new Date().toISOString(),
              questionId: question.id
            }
          });
          
          relationshipsProcessed++;
          console.log(`Created SME-validated relationship: ${joinInfo.fromId} -> ${joinInfo.toId} (question ${question.id})`);
        }
      } catch (error) {
        console.error(`Failed to process relationship question ${question.id}:`, error);
      }
    }
    
    
    // Get fresh statistics after updates (don't manually modify counts)
    const updatedStats = await neo4jService.getNamespaceStatistics(namespace);
    
    console.log('Incremental knowledge graph update completed:', {
      ...updatedStats,
      relationshipsProcessed: relationshipsProcessed
    });
    
    return updatedStats;
  }

  /**
   * Perform cross-model discovery when a new persona is created
   * Scans Neo4j for existing tables with matching canonical keys and generates SME questions
   */
  async function performCrossModelDiscovery(persona: any) {
    // Early exit if shared mode is disabled
    if (!neo4jService.isSharedNodesEnabled()) {
      console.log('Cross-model discovery skipped (shared mode disabled)');
      return;
    }
    
    let neo4jConnected = false;
    
    try {
      console.log(`🔍 Starting cross-model discovery for persona: ${persona.name} (${persona.id})`);
      
      const databaseId = persona.databaseId;
      if (!databaseId) {
        console.warn('⚠️  Persona has no databaseId, skipping cross-model discovery');
        return;
      }
      
      // Connect to Neo4j before querying
      const neo4jConnectionId = environmentService.getNeo4jConnectionId();
      const neo4jConnection = await storage.getConnection(neo4jConnectionId);
      
      if (!neo4jConnection) {
        console.warn('⚠️  Neo4j connection not found, skipping cross-model discovery');
        return;
      }
      
      neo4jConnected = await neo4jService.connect(neo4jConnection.config as any);
      if (!neo4jConnected) {
        console.warn('⚠️  Failed to connect to Neo4j, skipping cross-model discovery');
        return;
      }
      
      console.log('✓ Connected to Neo4j for cross-model discovery');
      
      // Get all existing tables in Neo4j for this database (with persona details included)
      const existingTables = await neo4jService.findTablesByDatabaseId(databaseId);
      console.log(`📊 Found ${existingTables.length} existing tables in Neo4j for database ${databaseId}`);
      
      if (existingTables.length === 0) {
        console.log('✓ No existing tables found, skipping cross-model discovery');
        return;
      }
      
      // Get tables that will be part of this persona (selected tables)
      const selectedTables = await storage.getSelectedTables(databaseId);
      console.log(`📋 Persona will include ${selectedTables.length} selected tables`);
      
      // Find overlapping tables (tables that exist in Neo4j and are selected for this persona)
      const overlaps: Array<{
        table: any;
        existingPersonas: Array<{ id: string; name: string; description: string }>;
        canonicalKey: string;
      }> = [];
      
      for (const table of selectedTables) {
        const canonicalKey = `${databaseId}.${table.schema}.${table.name}`;
        const existingTable = existingTables.find(t => t.canonicalKey === canonicalKey);
        
        if (existingTable && existingTable.personaIds.length > 0) {
          // Filter out the newly created persona to avoid self-overlap
          const otherPersonas = existingTable.personas.filter(p => p.id !== persona.id);
          
          // Only create overlap if table exists in OTHER personas (not just self)
          if (otherPersonas.length > 0) {
            overlaps.push({
              table,
              existingPersonas: otherPersonas,
              canonicalKey
            });
          }
        }
      }
      
      console.log(`🔗 Found ${overlaps.length} overlapping tables with existing personas`);
      
      // Generate SME questions for each overlap
      for (const overlap of overlaps) {
        const personaNames = overlap.existingPersonas.map(p => p.name).join(', ');
        
        // Create a relationship-type SME question about cross-model connections
        const question = {
          tableId: overlap.table.id,
          questionType: 'relationship' as const,
          questionText: `The table "${overlap.table.name}" appears in multiple personas: "${persona.name}" and "${personaNames}". Are there specific relationships or dependencies between how this table is used across these different business contexts?`,
          options: {
            databaseId: databaseId,
            personaId: persona.id,
            tableName: overlap.table.name,
            tableSchema: overlap.table.schema,
            canonicalKey: overlap.canonicalKey,
            newPersona: { id: persona.id, name: persona.name },
            existingPersonas: overlap.existingPersonas,
            discoveryType: 'cross-model-overlap'
          }
        };
        
        await storage.createSmeQuestion(question);
        console.log(`❓ Created cross-model SME question for table: ${overlap.table.name}`);
      }
      
      if (overlaps.length > 0) {
        console.log(`✅ Cross-model discovery complete: Generated ${overlaps.length} SME questions`);
      }
    } catch (error) {
      // Fail gracefully - don't break persona creation
      console.error('❌ Cross-model discovery failed (non-fatal):', error instanceof Error ? error.message : error);
    } finally {
      // Always disconnect from Neo4j
      if (neo4jConnected) {
        await neo4jService.disconnect();
        console.log('✓ Disconnected from Neo4j after cross-model discovery');
      }
    }
  }

  // Enhanced knowledge graph building function that incorporates SME responses (for new graphs)
  async function buildEnhancedKnowledgeGraph(databaseId: string) {
    const startTime = Date.now();
    console.log('Building enhanced knowledge graph for database:', databaseId, 'at', new Date().toISOString());
    
    // Create namespace for this database
    const namespace = `database_${databaseId}`;
    await neo4jService.createNamespace(namespace);
    
    // Get personas and their tables
    console.log('Fetching personas at', Date.now() - startTime + 'ms');
    const personas = await storage.getPersonasByDatabaseId(databaseId);
    console.log('Found', personas.length, 'personas at', Date.now() - startTime + 'ms');
    
    let stats = {
      personaCount: personas.length,
      tableCount: 0,
      columnCount: 0,
      valueCount: 0,
      relationshipCount: 0
    };
    
    for (let i = 0; i < personas.length; i++) {
      const persona = personas[i];
      console.log(`Processing persona ${i + 1}/${personas.length}:`, persona.name, 'at', Date.now() - startTime + 'ms');
      
      // Create Agent Persona node
      await neo4jService.createAgentPersona({
        id: persona.id,
        name: persona.name,
        description: persona.description,
        keywords: Array.isArray(persona.keywords) ? persona.keywords as string[] : [],
        namespace
      });
      
      // Get tables for this persona (for now, just get all selected tables)
      console.log('Fetching tables for persona at', Date.now() - startTime + 'ms');
      const tables = await storage.getSelectedTables(databaseId);
      console.log('Found', tables.length, 'tables at', Date.now() - startTime + 'ms');
      stats.tableCount += tables.length;
      
      for (const table of tables) {
        // Create Table node
        await neo4jService.createTableNode(persona.id, {
          id: table.id,
          name: table.name,
          schema: table.schema,
          description: `Table containing ${table.columnCount || 0} columns with data analysis context`,
          rowCount: table.rowCount ?? undefined,
          columnCount: table.columnCount ?? undefined,
          databaseId: table.databaseId
        });
        
        // Get and create Column nodes with SME context
        const columns = await storage.getColumnsByTableId(table.id);
        stats.columnCount += columns.length;
        
        // Get AI context for this table to include SME-validated descriptions
        const contextItem = await storage.getContextByTableId(table.id);
        
        for (const column of columns) {
          // Look for SME-validated column context
          let enhancedDescription = column.aiDescription;
          if (contextItem?.columnDescs && Array.isArray(contextItem.columnDescs)) {
            const columnDesc = contextItem.columnDescs.find(desc => desc.column_name === column.name);
            if (columnDesc) {
              enhancedDescription = columnDesc.description || column.aiDescription;
            }
          }
          
          await neo4jService.createColumnNode(table.id, {
            id: column.id,
            name: column.name,
            dataType: column.dataType,
            description: enhancedDescription ?? undefined,
            isNullable: column.isNullable ?? false,
            cardinality: column.cardinality ?? undefined,
            nullPercentage: parseFloat(column.nullPercentage || '0'),
            databaseId: table.databaseId,
            tableSchema: table.schema,
            tableName: table.name
          });
          
          // Create Value nodes for low-cardinality columns with AI context from enum values
          console.log(`[DEBUG] Incremental Update - Column ${column.name}: cardinality=${column.cardinality}, hasDistinctValues=${!!column.distinctValues}`);
          if (column.cardinality && column.cardinality < 100 && column.distinctValues) {
            console.log(`[DEBUG] ✓ Incremental Update - Column ${column.name} PASSED condition check - will create value nodes`);
            // Get enum values with AI context if they exist
            const enumValues = await storage.getEnumValuesByColumnId(column.id);
            const enumValueMap = new Map();
            enumValues.forEach((ev: any) => {
              enumValueMap.set(ev.value, { aiContext: ev.aiContext, aiHypothesis: ev.aiHypothesis });
            });
            
            let values = [];
            let valueNodesCreated = 0;
            let valueNodesWithContext = 0;
            
            // Try multiple parsing strategies for distinctValues
            try {
              values = JSON.parse(String(column.distinctValues));
            } catch (jsonError) {
              // Fallback: try CSV parsing for comma-separated values
              try {
                values = String(column.distinctValues).split(',').map(v => v.trim()).filter(v => v.length > 0);
                console.log(`Used CSV fallback for column ${column.name}: ${values.length} values`);
              } catch (csvError) {
                // Final fallback: semicolon or newline separated
                values = String(column.distinctValues).split(/[;\n]/).map(v => v.trim()).filter(v => v.length > 0);
                console.log(`Used delimiter fallback for column ${column.name}: ${values.length} values`);
              }
            }
            
            if (!Array.isArray(values) || values.length === 0) {
              console.warn(`No parseable values found for column ${column.name}, skipping value nodes`);
            } else {
              for (const value of values) {
                const enumData = enumValueMap.get(String(value));
                await neo4jService.createValueNode(column.id, {
                  id: `${column.id}_${value}`,
                  value: String(value),
                  aiContext: enumData?.aiContext,
                  aiHypothesis: enumData?.aiHypothesis
                });
                valueNodesCreated++;
                if (enumData?.aiContext || enumData?.aiHypothesis) {
                  valueNodesWithContext++;
                }
              }
              
              stats.valueCount += valueNodesCreated;
              console.log(`Created ${valueNodesCreated} value nodes for column ${column.name} (${valueNodesWithContext} with AI context)`);
            }
          }
        }
      }
    }
    
    // Get SME-validated foreign key relationships and create enhanced relationships
    const smeQuestions = await storage.getQuestionsByDatabaseId(databaseId);
    const answeredRelationshipQuestions = smeQuestions.filter(q => 
      q.isAnswered && q.questionType === 'relationship' && q.response
    );
    
    // Process SME-validated join suggestions from Q&A responses
    console.log(`Found ${answeredRelationshipQuestions.length} answered relationship questions`);
    
    for (const question of answeredRelationshipQuestions) {
      try {
        // Process validated join suggestions from SME responses  
        const joinInfo = await extractJoinInfoFromSMEResponse(question.questionText, question.response || '', databaseId);
        if (joinInfo) {
          // Create SME-validated relationship in Neo4j
          await neo4jService.createRelationship({
            fromId: joinInfo.fromId,
            toId: joinInfo.toId,
            type: joinInfo.type,
            properties: {
              smeResponse: question.response,
              confidence: 0.9, // High confidence since SME validated
              validatedAt: new Date().toISOString(),
              questionId: question.id
            }
          });
          
          stats.relationshipCount++;
          console.log(`Created SME-validated relationship: ${joinInfo.fromId} -> ${joinInfo.toId} (question ${question.id})`);
        }
      } catch (error) {
        console.error(`Failed to process relationship question ${question.id}:`, error);
      }
    }
    
    // Also create traditional foreign key relationships from all tables
    const allTables = await storage.getSelectedTables(databaseId);
    for (const table of allTables) {
      const foreignKeys = await storage.getForeignKeysByTableId(table.id);
      for (const fk of foreignKeys) {
        // In shared mode, construct columnKeys for cross-persona FK relationships
        let fromKey: string | undefined;
        let toKey: string | undefined;
        
        if (neo4jService.isSharedNodesEnabled()) {
          try {
            // Get column details to construct canonical keys
            const fromColumn = fk.fromColumnId ? await storage.getColumnById(fk.fromColumnId) : null;
            const toColumn = fk.toColumnId ? await storage.getColumnById(fk.toColumnId) : null;
            
            if (fromColumn && toColumn) {
              // Get table details for schema information
              const fromTable = await storage.getTable(fromColumn.tableId);
              const toTable = await storage.getTable(toColumn.tableId);
              
              // Validate all required fields are present before constructing keys
              if (fromTable && toTable && 
                  fromTable.schema && fromTable.name && fromColumn.name &&
                  toTable.schema && toTable.name && toColumn.name) {
                fromKey = `${databaseId}.${fromTable.schema}.${fromTable.name}.${fromColumn.name}`;
                toKey = `${databaseId}.${toTable.schema}.${toTable.name}.${toColumn.name}`;
                console.log(`🔗 Creating shared FK relationship: ${fromKey} -> ${toKey}`);
              } else {
                console.warn(`⚠️  Incomplete metadata for FK, falling back to IDs (from: ${fromTable?.name}.${fromColumn.name}, to: ${toTable?.name}.${toColumn.name})`);
              }
            }
          } catch (error) {
            console.warn(`⚠️  Failed to construct canonical keys for FK, falling back to IDs:`, error instanceof Error ? error.message : error);
          }
        }
        
        await neo4jService.createRelationship({
          fromId: fk.fromColumnId || '',
          toId: fk.toColumnId || '',
          fromKey,
          toKey,
          type: 'FOREIGN_KEY',
          properties: {
            confidence: parseFloat(fk.confidence || '0.5'),
            isValidated: fk.isValidated || false
          }
        });
        stats.relationshipCount++;
      }
    }
    
    const totalTime = Date.now() - startTime;
    console.log('Enhanced knowledge graph built successfully in', totalTime + 'ms:', stats);
    return stats;
  }

  // CSV upload endpoint for SME responses
  app.post("/api/databases/:id/upload-csv", (req, res) => {
    csvUpload.single('csvFile')(req, res, async (err) => {
      try {
        // Handle multer-specific errors first
        if (err) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: "File too large. Maximum size is 10MB." });
          }
          if (err.message === 'Only CSV files are allowed') {
            return res.status(400).json({ error: "Only CSV files are allowed. Please upload a .csv file." });
          }
          return res.status(400).json({ error: err.message });
        }

        const { id } = req.params;
        
        // Verify database exists
        const database = await storage.getDatabase(id);
        if (!database) {
          return res.status(404).json({ error: "Database not found" });
        }
        
        if (!req.file) {
          return res.status(400).json({ error: "No CSV file uploaded" });
        }

        // Convert buffer to string
        const csvData = req.file.buffer.toString('utf-8');
        
        // Process the CSV responses using existing service
        const csvProcessingResult = await smeInterviewService.processCSVResponse(csvData, id);
        
        // Get updated progress after processing
        const progress = await smeInterviewService.getInterviewProgress(id);

        // Handle persona creation if requested
        let personasCreated: any = null;
        const definePersonas = req.body?.definePersonas === 'true';
        const personasData = req.body?.personas;

        if (definePersonas && personasData) {
          try {
            const personas = JSON.parse(personasData);
            const createdPersonas = [];
            const failedPersonas = [];
            
            console.log(`Processing ${personas.length} personas for database ${id}`);
            
            // Get existing personas once to check for duplicates efficiently
            const existingPersonas = await storage.getPersonasByDatabaseId(id);
            const existingNames = new Set(existingPersonas.map(p => p.name.toLowerCase()));
            const newlyCreatedNames = new Set<string>();
            
            for (const personaData of personas) {
              try {
                // Validate using schema
                const validatedData = insertAgentPersonaSchema.parse({
                  databaseId: id,
                  name: personaData.name?.trim(),
                  description: personaData.description?.trim(),
                  keywords: personaData.keywords || []
                });
                
                // Check for duplicate name (existing or within this batch)
                const nameLower = validatedData.name.toLowerCase();
                if (existingNames.has(nameLower) || newlyCreatedNames.has(nameLower)) {
                  failedPersonas.push({ name: validatedData.name, reason: 'Duplicate name' });
                  continue;
                }
                
                const persona = await storage.createAgentPersona(validatedData);
                newlyCreatedNames.add(nameLower); // Track to prevent duplicates within this batch
                createdPersonas.push({
                  id: persona.id,
                  name: persona.name,
                  description: persona.description
                });
              } catch (validationError) {
                const personaName = personaData.name || 'Unknown';
                failedPersonas.push({ 
                  name: personaName, 
                  reason: validationError instanceof Error ? validationError.message : 'Validation failed' 
                });
              }
            }
            
            personasCreated = {
              count: createdPersonas.length,
              personas: createdPersonas,
              failed: failedPersonas.length > 0 ? failedPersonas : undefined
            };
            
            console.log(`Created ${createdPersonas.length} personas successfully, ${failedPersonas.length} failed for database ${id}`);
          } catch (error) {
            console.error('Error processing personas:', error);
            // Don't fail the entire upload if persona creation fails
          }
        }

        // Optionally build knowledge graph if Neo4j connection is available
        let graphBuildResult: any = null;
        
        // Parse form data fields (multer populates req.body for text fields)
        const buildKnowledgeGraph = req.body?.buildKnowledgeGraph === 'true';
        // Automatically select Neo4j connection based on environment
        const neo4jConnectionId = environmentService.getNeo4jConnectionId();
        
        if (buildKnowledgeGraph) {
          try {
            console.log('Building knowledge graph with connection:', neo4jConnectionId);
            const neo4jConnection = await storage.getConnection(neo4jConnectionId);
            if (neo4jConnection) {
              // Connect to Neo4j
              const connected = await neo4jService.connect(neo4jConnection.config as any);
              if (connected) {
                try {
                  // Update or build enhanced knowledge graph with SME responses
                  graphBuildResult = await updateEnhancedKnowledgeGraph(id);
                  console.log('Knowledge graph updated successfully:', graphBuildResult);
                } finally {
                  // Always disconnect after building
                  await neo4jService.disconnect();
                }
              } else {
                console.warn('Failed to connect to Neo4j');
              }
            } else {
              console.warn('Neo4j connection not found:', neo4jConnectionId);
            }
          } catch (graphError) {
            console.error('Knowledge graph building failed:', graphError);
            // Don't fail the entire operation if graph building fails
          }
        }
        
        res.json({ 
          success: true, 
          message: "CSV responses processed successfully",
          progress: progress,
          csvProcessing: csvProcessingResult,
          knowledgeGraphBuilt: !!graphBuildResult,
          graphStats: graphBuildResult || null,
          personasCreated: personasCreated
        });
      } catch (error) {
        console.error('CSV upload error:', error);
        res.status(500).json({ error: error instanceof Error ? error.message : "CSV upload failed" });
      }
    });
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
      
      // Trigger cross-model discovery if shared mode is enabled
      if (neo4jService.isSharedNodesEnabled()) {
        try {
          await performCrossModelDiscovery(persona);
        } catch (error) {
          console.error('Cross-model discovery failed (non-fatal):', error);
          // Don't fail persona creation if discovery fails
        }
      }
      
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

  // Get individual job by database and job ID
  app.get("/api/databases/:id/jobs/:jobId", async (req, res) => {
    try {
      const { id, jobId } = req.params;
      const jobs = await storage.getAnalysisJobs(id);
      const job = jobs.find(j => j.id === jobId);
      
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }
      
      res.json(job);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to fetch job" });
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
      console.log('Build graph request received:', {
        params: req.params,
        body: req.body,
        headers: req.headers['content-type']
      });
      // Automatically select Neo4j connection based on environment
      const neo4jConnectionId = environmentService.getNeo4jConnectionId();
      console.log('Auto-selected Neo4j connection for build-graph:', neo4jConnectionId);
      
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
        console.log('Starting knowledge graph build process...');
        
        // Create namespace for this database
        const namespace = `database_${id}`;
        console.log('Creating namespace:', namespace);
        await neo4jService.createNamespace(namespace);
        
        // Get personas and their tables
        console.log('Fetching personas for database:', id);
        let personas = await storage.getPersonasByDatabaseId(id);
        console.log('Found personas:', personas.length);
        
        // If no personas exist, create default personas from SME responses and tables
        if (personas.length === 0) {
          console.log('No personas found, creating default personas from available data...');
          try {
            personas = await createDefaultPersonas(id);
            console.log(`Successfully created ${personas.length} default personas`);
          } catch (error) {
            console.error('Error creating default personas:', error);
            throw error;
          }
        }
        
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
              description: `Table containing ${table.columnCount || 0} columns with data analysis context`,
              rowCount: table.rowCount ?? undefined,
              columnCount: table.columnCount ?? undefined,
              databaseId: table.databaseId
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
                nullPercentage: parseFloat(column.nullPercentage || '0'),
                databaseId: table.databaseId,
                tableSchema: table.schema,
                tableName: table.name
              });
              
              // Create Value nodes for low-cardinality columns with AI context from enum values
              console.log(`[DEBUG] Column ${column.name}: cardinality=${column.cardinality}, hasDistinctValues=${!!column.distinctValues}, distinctValues=${JSON.stringify(column.distinctValues).substring(0, 100)}...`);
              if (column.cardinality && column.cardinality < 100 && column.distinctValues) {
                console.log(`[DEBUG] ✓ Column ${column.name} PASSED condition check - will create value nodes`);
                // Get enum values with AI context if they exist
                const enumValues = await storage.getEnumValuesByColumnId(column.id);
                const enumValueMap = new Map();
                enumValues.forEach((ev: any) => {
                  enumValueMap.set(ev.value, { aiContext: ev.aiContext, aiHypothesis: ev.aiHypothesis });
                });
                
                let values = [];
                let valueNodesCreated = 0;
                let valueNodesWithContext = 0;
                
                // Try multiple parsing strategies for distinctValues
                try {
                  values = JSON.parse(String(column.distinctValues));
                } catch (jsonError) {
                  // Fallback: try CSV parsing for comma-separated values
                  try {
                    values = String(column.distinctValues).split(',').map(v => v.trim()).filter(v => v.length > 0);
                    console.log(`Used CSV fallback for column ${column.name}: ${values.length} values`);
                  } catch (csvError) {
                    // Final fallback: semicolon or newline separated
                    values = String(column.distinctValues).split(/[;\n]/).map(v => v.trim()).filter(v => v.length > 0);
                    console.log(`Used delimiter fallback for column ${column.name}: ${values.length} values`);
                  }
                }
                
                if (!Array.isArray(values) || values.length === 0) {
                  console.warn(`No parseable values found for column ${column.name}, skipping value nodes`);
                } else {
                  for (const value of values) {
                    const enumData = enumValueMap.get(String(value));
                    await neo4jService.createValueNode(column.id, {
                      id: `${column.id}_${value}`,
                      value: String(value),
                      aiContext: enumData?.aiContext,
                      aiHypothesis: enumData?.aiHypothesis
                    });
                    valueNodesCreated++;
                    if (enumData?.aiContext || enumData?.aiHypothesis) {
                      valueNodesWithContext++;
                    }
                  }
                  
                  console.log(`Created ${valueNodesCreated} value nodes for column ${column.name} (${valueNodesWithContext} with AI context)`);
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
        
        // Process SME relationship questions to create validated joins
        let totalSMERelationships = 0;
        console.log('Processing SME relationship questions for all personas...');
        
        for (const persona of personas) {
          const personaQuestions = await storage.getQuestionsByDatabaseId(id);
          const relationshipQuestions = personaQuestions.filter((q: any) => q.isAnswered && q.questionType === 'relationship');
          
          console.log(`Processing ${relationshipQuestions.length} answered relationship questions for persona ${persona.name}`);
          
          for (const question of relationshipQuestions) {
            try {
              // Process validated join suggestions from SME responses
              const joinInfo = await extractJoinInfoFromSMEResponse(question.questionText, question.response || '', id);
              if (joinInfo) {
                // Create SME-validated relationship in Neo4j
                await neo4jService.createRelationship({
                  fromId: joinInfo.fromId,
                  toId: joinInfo.toId,
                  type: 'SME_VALIDATED_JOIN',
                  properties: {
                    confidence: 0.9,
                    source: 'SME',
                    questionId: question.id
                  }
                });
                
                totalSMERelationships++;
                console.log(`Created SME-validated relationship: ${joinInfo.fromId} -> ${joinInfo.toId} (question ${question.id})`);
              } else {
                console.log(`No join info extracted for question ${question.id} - response was not affirmative`);
              }
            } catch (error) {
              console.error(`Failed to process relationship question ${question.id}:`, error);
            }
          }
        }
        
        console.log(`Graph build completed. Total SME-validated relationships created: ${totalSMERelationships}`);
        res.json({ success: true, namespace, smeRelationships: totalSMERelationships });
        
      } finally {
        await neo4jService.disconnect();
      }
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Graph building failed" });
    }
  });

  // Temporary endpoint to clear knowledge graph
  app.post("/api/databases/:id/clear-graph", async (req, res) => {
    try {
      const { id } = req.params;
      // Automatically select Neo4j connection based on environment
      const neo4jConnectionId = environmentService.getNeo4jConnectionId();
      console.log('Auto-selected Neo4j connection for clear-graph:', neo4jConnectionId);
      
      const neo4jConnection = await storage.getConnection(neo4jConnectionId);
      if (!neo4jConnection) {
        return res.status(404).json({ error: "Neo4j connection not found" });
      }
      
      const connected = await neo4jService.connect(neo4jConnection.config as any);
      if (!connected) {
        return res.status(500).json({ error: "Failed to connect to Neo4j" });
      }
      
      try {
        const namespace = `database_${id}`;
        await neo4jService.clearNamespace(namespace);
        console.log(`Cleared namespace: ${namespace}`);
        res.json({ success: true, message: "Knowledge graph cleared successfully" });
      } finally {
        await neo4jService.disconnect();
      }
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to clear graph" });
    }
  });

  app.get("/api/databases/:id/graph-stats", async (req, res) => {
    try {
      const { id } = req.params;
      // Automatically select Neo4j connection based on environment
      const neo4jConnectionId = environmentService.getNeo4jConnectionId();
      
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

  // Backfill canonical keys for existing Neo4j nodes
  app.post("/api/neo4j/backfill-canonical-keys", async (req, res) => {
    try {
      console.log('🔄 Starting canonical key backfill migration...');
      const result = await neo4jBackfillService.backfillCanonicalKeys();
      
      if (result.success) {
        console.log(`✅ Backfill completed: ${result.tablesUpdated} tables, ${result.columnsUpdated} columns updated`);
        res.json(result);
      } else {
        console.error('❌ Backfill failed:', result.errors);
        res.status(500).json(result);
      }
    } catch (error) {
      console.error('❌ Backfill endpoint error:', error);
      res.status(500).json({ 
        success: false,
        tablesUpdated: 0,
        columnsUpdated: 0,
        valuesUpdated: 0,
        errors: [error instanceof Error ? error.message : String(error)]
      });
    }
  });

  // Get statistics on nodes missing canonical keys
  app.get("/api/neo4j/backfill-stats", async (req, res) => {
    try {
      const stats = await neo4jBackfillService.getBackfillStatistics();
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to get backfill stats" });
    }
  });

  // Deduplicate nodes by merging duplicates with same canonical keys
  app.post("/api/neo4j/deduplicate-nodes", async (req, res) => {
    try {
      console.log('🔄 Starting node deduplication...');
      const result = await neo4jDeduplicationService.deduplicateNodes();
      
      if (result.success) {
        console.log(`✅ Deduplication completed: ${result.tablesMerged} tables, ${result.columnsMerged} columns merged`);
        res.json(result);
      } else {
        console.error('❌ Deduplication failed:', result.errors);
        res.status(500).json(result);
      }
    } catch (error) {
      console.error('❌ Deduplication endpoint error:', error);
      res.status(500).json({ 
        success: false,
        tablesMerged: 0,
        columnsMerged: 0,
        valuesMerged: 0,
        errors: [error instanceof Error ? error.message : String(error)],
        details: []
      });
    }
  });

  // Get statistics on duplicate nodes
  app.get("/api/neo4j/deduplication-stats", async (req, res) => {
    try {
      const stats = await neo4jDeduplicationService.getDeduplicationStatistics();
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to get deduplication stats" });
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
