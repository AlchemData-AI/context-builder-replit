import { 
  connections, databases, tables, columns, foreignKeys, 
  agentPersonas, personaTables, smeQuestions, analysisJobs,
  type Connection, type InsertConnection, type Database, type InsertDatabase,
  type Table, type InsertTable, type Column, type ForeignKey,
  type AgentPersona, type InsertAgentPersona, type SmeQuestion, type InsertSmeQuestion,
  type AnalysisJob, type InsertAnalysisJob, type User, type InsertUser
} from "@shared/schema";
import { db } from "./db";
import { eq, and, desc } from "drizzle-orm";

export interface IStorage {
  // User methods
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  // Connection methods
  createConnection(connection: InsertConnection & { userId: string }): Promise<Connection>;
  getConnection(id: string): Promise<Connection | undefined>;
  getConnectionsByUserId(userId: string): Promise<Connection[]>;
  updateConnectionStatus(id: string, status: string, lastTested?: Date): Promise<void>;

  // Database methods
  createDatabase(database: InsertDatabase): Promise<Database>;
  getDatabasesByConnectionId(connectionId: string): Promise<Database[]>;
  getDatabase(id: string): Promise<Database | undefined>;

  // Table methods
  createTable(table: InsertTable): Promise<Table>;
  getTablesByDatabaseId(databaseId: string): Promise<Table[]>;
  getTable(id: string): Promise<Table | undefined>;
  updateTableSelection(id: string, isSelected: boolean, sampleSize?: number): Promise<void>;
  getSelectedTables(databaseId: string): Promise<Table[]>;

  // Column methods
  createColumn(column: Omit<Column, 'id' | 'createdAt'>): Promise<Column>;
  getColumnsByTableId(tableId: string): Promise<Column[]>;
  updateColumnStats(columnId: string, stats: Partial<Column>): Promise<void>;

  // Foreign key methods
  createForeignKey(foreignKey: Omit<ForeignKey, 'id' | 'createdAt'>): Promise<ForeignKey>;
  getForeignKeysByTableId(tableId: string): Promise<ForeignKey[]>;

  // Agent persona methods
  createAgentPersona(persona: InsertAgentPersona): Promise<AgentPersona>;
  getPersonasByDatabaseId(databaseId: string): Promise<AgentPersona[]>;
  addTableToPersona(personaId: string, tableId: string): Promise<void>;

  // SME question methods
  createSmeQuestion(question: InsertSmeQuestion): Promise<SmeQuestion>;
  getQuestionsByDatabaseId(databaseId: string): Promise<SmeQuestion[]>;
  answerSmeQuestion(questionId: string, response: string): Promise<void>;

  // Analysis job methods
  createAnalysisJob(job: InsertAnalysisJob): Promise<AnalysisJob>;
  getAnalysisJobs(databaseId: string): Promise<AnalysisJob[]>;
  updateAnalysisJob(jobId: string, updates: Partial<AnalysisJob>): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(connections).where(eq(connections.id, id));
    return user || undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(connections).where(eq(connections.name, username));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db
      .insert(connections)
      .values(insertUser as any)
      .returning();
    return user as any;
  }

  async createConnection(connection: InsertConnection & { userId: string }): Promise<Connection> {
    const [result] = await db
      .insert(connections)
      .values(connection)
      .returning();
    return result;
  }

  async getConnection(id: string): Promise<Connection | undefined> {
    const [connection] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, id));
    return connection || undefined;
  }

  async getConnectionsByUserId(userId: string): Promise<Connection[]> {
    return await db
      .select()
      .from(connections)
      .where(eq(connections.userId, userId))
      .orderBy(desc(connections.createdAt));
  }

  async updateConnectionStatus(id: string, status: string, lastTested?: Date): Promise<void> {
    await db
      .update(connections)
      .set({ 
        status,
        lastTested: lastTested || new Date()
      })
      .where(eq(connections.id, id));
  }

  async createDatabase(database: InsertDatabase): Promise<Database> {
    const [result] = await db
      .insert(databases)
      .values(database)
      .returning();
    return result;
  }

  async getDatabasesByConnectionId(connectionId: string): Promise<Database[]> {
    return await db
      .select()
      .from(databases)
      .where(eq(databases.connectionId, connectionId))
      .orderBy(desc(databases.createdAt));
  }

  async getDatabase(id: string): Promise<Database | undefined> {
    const [database] = await db
      .select()
      .from(databases)
      .where(eq(databases.id, id));
    return database || undefined;
  }

  async createTable(table: InsertTable): Promise<Table> {
    const [result] = await db
      .insert(tables)
      .values(table)
      .returning();
    return result;
  }

  async getTablesByDatabaseId(databaseId: string): Promise<Table[]> {
    return await db
      .select()
      .from(tables)
      .where(eq(tables.databaseId, databaseId))
      .orderBy(desc(tables.rowCount));
  }

  async getTable(id: string): Promise<Table | undefined> {
    const [table] = await db
      .select()
      .from(tables)
      .where(eq(tables.id, id));
    return table || undefined;
  }

  async updateTableSelection(id: string, isSelected: boolean, sampleSize?: number): Promise<void> {
    const updates: Partial<Table> = { isSelected };
    if (sampleSize !== undefined) {
      updates.sampleSize = sampleSize;
    }
    
    await db
      .update(tables)
      .set(updates)
      .where(eq(tables.id, id));
  }

  async getSelectedTables(databaseId: string): Promise<Table[]> {
    return await db
      .select()
      .from(tables)
      .where(and(
        eq(tables.databaseId, databaseId),
        eq(tables.isSelected, true)
      ));
  }

  async createColumn(column: Omit<Column, 'id' | 'createdAt'>): Promise<Column> {
    const [result] = await db
      .insert(columns)
      .values(column as any)
      .returning();
    return result;
  }

  async getColumnsByTableId(tableId: string): Promise<Column[]> {
    return await db
      .select()
      .from(columns)
      .where(eq(columns.tableId, tableId));
  }

  async updateColumnStats(columnId: string, stats: Partial<Column>): Promise<void> {
    await db
      .update(columns)
      .set(stats)
      .where(eq(columns.id, columnId));
  }

  async createForeignKey(foreignKey: Omit<ForeignKey, 'id' | 'createdAt'>): Promise<ForeignKey> {
    const [result] = await db
      .insert(foreignKeys)
      .values(foreignKey as any)
      .returning();
    return result;
  }

  async getForeignKeysByTableId(tableId: string): Promise<ForeignKey[]> {
    return await db
      .select()
      .from(foreignKeys)
      .where(eq(foreignKeys.fromTableId, tableId));
  }

  async createAgentPersona(persona: InsertAgentPersona): Promise<AgentPersona> {
    const [result] = await db
      .insert(agentPersonas)
      .values(persona)
      .returning();
    return result;
  }

  async getPersonasByDatabaseId(databaseId: string): Promise<AgentPersona[]> {
    return await db
      .select()
      .from(agentPersonas)
      .where(eq(agentPersonas.databaseId, databaseId));
  }

  async addTableToPersona(personaId: string, tableId: string): Promise<void> {
    await db
      .insert(personaTables)
      .values({ personaId, tableId });
  }

  async createSmeQuestion(question: InsertSmeQuestion): Promise<SmeQuestion> {
    const [result] = await db
      .insert(smeQuestions)
      .values(question)
      .returning();
    return result;
  }

  async getQuestionsByDatabaseId(databaseId: string): Promise<SmeQuestion[]> {
    return await db
      .select()
      .from(smeQuestions)
      .where(eq(smeQuestions.tableId, databaseId));
  }

  async answerSmeQuestion(questionId: string, response: string): Promise<void> {
    await db
      .update(smeQuestions)
      .set({ 
        response,
        isAnswered: true
      })
      .where(eq(smeQuestions.id, questionId));
  }

  async createAnalysisJob(job: InsertAnalysisJob): Promise<AnalysisJob> {
    const [result] = await db
      .insert(analysisJobs)
      .values(job as any)
      .returning();
    return result;
  }

  async getAnalysisJobs(databaseId: string): Promise<AnalysisJob[]> {
    return await db
      .select()
      .from(analysisJobs)
      .where(eq(analysisJobs.databaseId, databaseId))
      .orderBy(desc(analysisJobs.createdAt));
  }

  async updateAnalysisJob(jobId: string, updates: Partial<AnalysisJob>): Promise<void> {
    await db
      .update(analysisJobs)
      .set(updates)
      .where(eq(analysisJobs.id, jobId));
  }
}

export const storage = new DatabaseStorage();
