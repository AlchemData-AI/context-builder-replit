# Overview

This AlchemData application is a context builder designed to create hierarchical knowledge graphs from database schemas. It provides a comprehensive data analysis and documentation platform through automated schema discovery, statistical analysis, AI-powered context generation, and human-in-the-loop validation via Subject Matter Expert (SME) interviews. The system supports multi-layered context building, progressing from database connection validation and schema discovery to AI context generation, SME interviews, and finally, knowledge graph construction using Neo4j. A key feature is the "shared node architecture" in Neo4j, enabling context accumulation and cost savings by reusing AI-generated descriptions and automatically applying foreign key relationships across multiple data models (personas). The system also includes an incremental join discovery mechanism to automatically detect foreign key relationships.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Frontend
- **Framework**: React 18 with TypeScript and Vite.
- **UI Components**: Radix UI primitives with shadcn/ui, styled using Tailwind CSS.
- **State Management**: TanStack Query for server state, local React state for UI.
- **Routing**: Wouter for client-side routing.

## Backend
- **Runtime**: Node.js with Express.js REST API.
- **Language**: TypeScript with ES modules.
- **Database ORM**: Drizzle ORM for type-safe operations.
- **Service Layer**: Modular services for PostgreSQL analysis, Neo4j, Gemini AI, statistical analysis, and SME management.

## Data Storage
- **Primary Database**: PostgreSQL (Neon serverless).
- **Schema Management**: Drizzle migrations.
- **Knowledge Graph**: Neo4j for hierarchical relationships.
- **Session Storage**: PostgreSQL-based session management.

## Core Data Models
Users, Connections, Databases & Tables, Columns, Agent Personas, SME Questions, and Analysis Jobs.

## Authentication and Authorization
Session-based authentication with Express sessions and PostgreSQL storage, supporting multi-tenant user-scoped data isolation.

## AI Integration
- **LLM Provider**: Google Gemini AI for context generation, description creation, and SME question formulation.
- **Human-in-the-Loop**: Workflow requires human validation of AI-generated content.

## Knowledge Graph Design
- **Hierarchy**: Four-level structure (Agent Personas → Tables → Columns → Values).
- **Cardinality-based Storage**: Low-cardinality columns (<=100 values) expanded to value nodes; high-cardinality (>5000 values) stored as metadata.
- **Relationships**: Foreign key relationships and AI-suggested semantic relationships.
- **Multi-layered Context**: System metadata, AI-generated descriptions, and human-validated business logic.
- **Shared Node Architecture**: A single canonical node for each table/column/value across multiple personas in Neo4j, enabling context accumulation, cost savings, and automatic cross-model relationships.

## Key Features
- **Incremental Join Discovery**: Automated detection of foreign key relationships using PostgreSQL catalog extraction and semantic analysis with heuristic pattern matching.
- **Context Reuse**: Checks Neo4j for existing canonical nodes before LLM calls to reduce costs.
- **Cross-Model Relationship Discovery**: Automatically detects overlapping tables and generates SME questions for validation.

# External Dependencies

## Database Services
- **Neon PostgreSQL**: Serverless PostgreSQL hosting.
- **Neo4j**: Graph database.

## AI/ML Services
- **Google Gemini AI**: Large language model.

## Frontend Libraries
- **TanStack Query**: Server state management.
- **Radix UI**: Accessible component primitives.
- **Tailwind CSS**: Utility-first CSS framework.
- **Wouter**: Lightweight routing library.

## Backend Libraries
- **Drizzle ORM**: Type-safe PostgreSQL ORM.
- **Express.js**: Web application framework.
- **neo4j-driver**: Official Neo4j driver.
- **connect-pg-simple**: PostgreSQL session store.