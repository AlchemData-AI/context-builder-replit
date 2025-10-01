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
  - **Status**: Infrastructure complete but requires FK validation gates (see # Recent Changes below)
  - Catalog extraction: ✅ Working
  - Semantic analysis: ✅ Working  
  - Integration: ✅ Integrated into build pipeline
  - **Issue**: Current heuristic promotes descriptive columns (title, description) as FKs - needs value-level validation
- **Context Reuse**: Checks Neo4j for existing canonical nodes before LLM calls to reduce costs.
- **Cross-Model Relationship Discovery**: Automatically detects overlapping tables and generates SME questions for validation.

# Recent Changes

## Incremental Join Discovery - October 1, 2025

### Completed
- ✅ Implemented IncrementalJoinDiscoveryService with PostgreSQL catalog extraction
- ✅ Three-tier semantic analysis (exact match 0.85, FK pattern 0.80, suffix 0.65)
- ✅ Integrated into knowledge graph build pipeline  
- ✅ Successfully tested with clinical trials database (discovered 34 relationships)
- ✅ Cross-persona FK relationships using canonical keys

### Architect Review Findings - RESOLVED
**Critical Issue**: Heuristic incorrectly promoted descriptive columns as FKs with auto-persist behavior.

**Fix Applied**: Removed auto-persist for all discovered FKs. All relationships now require human validation via SME workflow.

**Implementation** (October 1, 2025):
- ✅ Modified IncrementalJoinDiscoveryService to create SME questions for ALL discovered FKs (no auto-persist)
- ✅ Implemented storage methods: `updateForeignKeyValidation()`, `deleteForeignKey()`, `getSmeQuestionById()`
- ✅ API route `/api/sme-questions/:id/answer` handles FK validation/deletion based on user responses
- ✅ Graph building syncs only validated FKs to Neo4j
- ✅ False positive FKs (title, description) now require user approval before inclusion
- ✅ **CSV Export/Import Workflow**: Complete FK validation via Excel
  - Export: `/api/databases/:id/export-csv` includes dedicated FOREIGN_KEY section with FK_ID, table/column names, confidence, and validation status
  - Import: `/api/databases/:id/upload-csv` parses Validation_Response column (VALIDATED/REJECTED) and updates database accordingly
  - User workflow: Export CSV → Edit in Excel → Mark FKs as VALIDATED/REJECTED → Import CSV → System updates FK status automatically

**Status**: Critical issue resolved. All FKs go through human-in-the-loop validation via SME questions OR CSV import.

### Future Enhancement (Optional)
Add value-level validation to reduce SME questions by pre-filtering obvious non-FKs:
1. **Target uniqueness check**: Target column >95% distinct
2. **Referential coverage**: >95% of source values exist in target
3. **Cardinality analysis**: Many-to-one relationship pattern
4. **Column naming patterns**: Prioritize _id suffixes, numeric types

This would auto-reject descriptive columns (title, description) before creating SME questions, improving user experience.

### Test Data
- Database: ctgov (Clinical Trials)
- Tables: outcome_measurements + baseline_measurements
- Current result: 34 "FKs" discovered (includes false positives)
- Expected result after fix: ~5-10 real FKs (id, nct_id, result_group_id, etc.)

## SME Question Filtering - October 1, 2025

### Implemented Filters
To reduce noise and improve SME question quality, the following filters are applied during question generation:

1. **Timestamp/Date Column Filter**: Excludes columns with temporal data types (timestamp, date, time, interval) and common temporal column names (created_at, updated_at, date_partition_delta, etc.)

2. **High-Cardinality Filter** (NEW): Excludes columns where cardinality ratio >= 20%
   - **Calculation**: cardinality ratio = (distinct values / total rows)
   - **Purpose**: Filters out IDs, order IDs, and other near-unique columns that don't need business logic validation
   - **Examples filtered**: order_id, transaction_id, date_partition_delta (if not caught by timestamp filter)
   - **Examples included**: status codes, categories, flags, enum values (< 20% cardinality ratio)

3. **FK Discovery Integration**: Automatically runs after context generation to create FK validation questions
   - Manual trigger via "Discover Relationships" button on SME Interview page
   - Auto-triggered after "Generate Context & Questions" workflow completes

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