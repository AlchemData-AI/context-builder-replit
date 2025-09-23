import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, jsonb, boolean, decimal } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const connections = pgTable("connections", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  name: text("name").notNull(),
  type: text("type").notNull(), // 'postgresql', 'gemini', 'neo4j'
  config: jsonb("config").notNull(),
  status: text("status").default("pending"), // 'connected', 'failed', 'pending'
  lastTested: timestamp("last_tested"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const databases = pgTable("databases", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  connectionId: varchar("connection_id").notNull(),
  name: text("name").notNull(),
  schema: text("schema").default("public"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const tables = pgTable("tables", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  databaseId: varchar("database_id").notNull(),
  name: text("name").notNull(),
  schema: text("schema").notNull(),
  rowCount: integer("row_count"),
  columnCount: integer("column_count"),
  lastUpdated: timestamp("last_updated"),
  isSelected: boolean("is_selected").default(false),
  sampleSize: integer("sample_size").default(1000),
  createdAt: timestamp("created_at").defaultNow(),
});

export const columns = pgTable("columns", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tableId: varchar("table_id").notNull(),
  name: text("name").notNull(),
  dataType: text("data_type").notNull(),
  isNullable: boolean("is_nullable").default(true),
  isUnique: boolean("is_unique").default(false),
  cardinality: integer("cardinality"),
  nullPercentage: decimal("null_percentage"),
  minValue: text("min_value"),
  maxValue: text("max_value"),
  distinctValues: jsonb("distinct_values"),
  aiDescription: text("ai_description"),
  smeValidated: boolean("sme_validated").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const foreignKeys = pgTable("foreign_keys", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fromTableId: varchar("from_table_id").notNull(),
  fromColumnId: varchar("from_column_id").notNull(),
  toTableId: varchar("to_table_id").notNull(),
  toColumnId: varchar("to_column_id").notNull(),
  confidence: decimal("confidence").default("1.0"),
  isValidated: boolean("is_validated").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const agentPersonas = pgTable("agent_personas", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  databaseId: varchar("database_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  keywords: jsonb("keywords"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const personaTables = pgTable("persona_tables", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  personaId: varchar("persona_id").notNull(),
  tableId: varchar("table_id").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const smeQuestions = pgTable("sme_questions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tableId: varchar("table_id"),
  columnId: varchar("column_id"),
  questionType: text("question_type").notNull(), // 'table', 'column', 'relationship', 'ambiguity'
  questionText: text("question_text").notNull(),
  options: jsonb("options"),
  response: text("response"),
  isAnswered: boolean("is_answered").default(false),
  priority: text("priority").default("medium"), // 'high', 'medium', 'low'
  createdAt: timestamp("created_at").defaultNow(),
});

export const analysisJobs = pgTable("analysis_jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  databaseId: varchar("database_id").notNull(),
  type: text("type").notNull(), // 'schema', 'statistical', 'ai_context', 'join_detection'
  status: text("status").default("pending"), // 'pending', 'running', 'completed', 'failed'
  progress: integer("progress").default(0),
  result: jsonb("result"),
  error: text("error"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
  // Batch processing fields
  totalUnits: integer("total_units").default(0),
  completedUnits: integer("completed_units").default(0),
  batchSize: integer("batch_size").default(1),
  processedTableIds: jsonb("processed_table_ids").default('[]'),
  nextIndex: integer("next_index").default(0),
  batchIndex: integer("batch_index").default(0),
  lastError: text("last_error"),
});

export const contextItems = pgTable("context_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  databaseId: varchar("database_id").notNull(),
  tableId: varchar("table_id").notNull(),
  tableDesc: jsonb("table_desc"),
  columnDescs: jsonb("column_descs"),
  questionsGenerated: integer("questions_generated").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Insert schemas
export const insertConnectionSchema = createInsertSchema(connections).pick({
  name: true,
  type: true,
  config: true,
});

export const insertDatabaseSchema = createInsertSchema(databases).pick({
  connectionId: true,
  name: true,
  schema: true,
});

export const insertTableSchema = createInsertSchema(tables).pick({
  databaseId: true,
  name: true,
  schema: true,
  rowCount: true,
  columnCount: true,
  isSelected: true,
  sampleSize: true,
});

export const insertAgentPersonaSchema = createInsertSchema(agentPersonas).pick({
  databaseId: true,
  name: true,
  description: true,
  keywords: true,
});

export const insertSmeQuestionSchema = createInsertSchema(smeQuestions).pick({
  tableId: true,
  columnId: true,
  questionType: true,
  questionText: true,
  options: true,
  priority: true,
});

export const insertAnalysisJobSchema = createInsertSchema(analysisJobs).pick({
  databaseId: true,
  type: true,
  status: true,
  progress: true,
  result: true,
  error: true,
  startedAt: true,
  completedAt: true,
  totalUnits: true,
  completedUnits: true,
  batchSize: true,
  processedTableIds: true,
  nextIndex: true,
  batchIndex: true,
  lastError: true,
});

export const insertContextItemSchema = createInsertSchema(contextItems).pick({
  databaseId: true,
  tableId: true,
  tableDesc: true,
  columnDescs: true,
  questionsGenerated: true,
});

// Types
export type InsertConnection = z.infer<typeof insertConnectionSchema>;
export type Connection = typeof connections.$inferSelect;
export type InsertDatabase = z.infer<typeof insertDatabaseSchema>;
export type Database = typeof databases.$inferSelect;
export type InsertTable = z.infer<typeof insertTableSchema>;
export type Table = typeof tables.$inferSelect;
export type Column = typeof columns.$inferSelect;
export type ForeignKey = typeof foreignKeys.$inferSelect;
export type AgentPersona = typeof agentPersonas.$inferSelect;
export type InsertAgentPersona = z.infer<typeof insertAgentPersonaSchema>;
export type SmeQuestion = typeof smeQuestions.$inferSelect;
export type InsertSmeQuestion = z.infer<typeof insertSmeQuestionSchema>;
export type AnalysisJob = typeof analysisJobs.$inferSelect;
export type InsertAnalysisJob = z.infer<typeof insertAnalysisJobSchema>;
export type ContextItem = typeof contextItems.$inferSelect;
export type InsertContextItem = z.infer<typeof insertContextItemSchema>;
export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});
