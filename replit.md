# Overview

This is a sophisticated context builder application for AlchemData, designed to create hierarchical knowledge graphs from database schemas. The system serves as a comprehensive data analysis and documentation platform that combines automated schema discovery, statistical analysis, AI-powered context generation, and human-in-the-loop validation through Subject Matter Expert (SME) interviews.

The application implements a multi-layered approach to building context:
1. Automated system-level metadata extraction from database schemas
2. AI-assisted description generation and relationship discovery
3. Human validation and refinement through structured interviews
4. Knowledge graph construction using Neo4j for hierarchical data representation

The core workflow progresses through database connection validation, schema discovery, sampling configuration, statistical analysis, AI context generation, SME interviews, and finally knowledge graph construction.

# Recent Changes (October 2025)

## Shared Node Architecture Implementation
**Date:** October 1, 2025  
**Status:** Phase 1 complete - dual-write mode implemented and production-ready

### Overview
Implemented a new shared node architecture in Neo4j where a single canonical node exists for each table/column/value across multiple data models (personas). This enables:
- **Context Accumulation**: AI-generated descriptions are reused across personas
- **Cost Savings**: Reduced LLM API calls by reusing existing context
- **Automatic Cross-Model Relationships**: Foreign keys discovered in one persona automatically apply to all

### Implementation Details
1. **Canonical Keys Added (Task 1 - Complete)**
   - Table nodes: `canonicalKey = ${databaseId}.${schema}.${name}`
   - Column nodes: `columnKey = ${databaseId}.${schema}.${table}.${column}`
   - Keys generated automatically for all new nodes
   - Backward compatible - existing id-based lookups preserved

2. **Feature-Flagged Dual-Write Mode (Task 2 - Complete)**
   - Environment variable: `NEO4J_USE_CANONICAL_KEYS` (default: false)
   - When enabled: Nodes MERGE by canonical keys, context shared across personas
   - When disabled: Legacy id-based behavior (production default)
   - All methods support both modes: createTableNode, createColumnNode, createValueNode, createRelationship, updateColumnDescription
   - Last-wins strategy for conflicting descriptions

### Architecture Decisions
- **One canonical definition per table/column** shared across all personas (not persona-isolated)
- **Context strategy**: Last-wins with review - new users see existing context, can override
- **Global relationships**: Foreign keys discovered in any persona automatically apply to all
- **Backward compatibility**: Fully maintained - no breaking changes to existing functionality

3. **Context Reuse Service (Task 3 - Complete)**
   - Checks Neo4j for existing canonical nodes before making LLM calls
   - Graceful fallback if Neo4j unavailable
   - Last-wins persistence strategy for conflicting descriptions
   - Cost savings logging shows reused vs. regenerated context
   - Force regeneration option available

4. **Shared FK Relationships (Task 4 - Complete)**
   - Foreign key relationships use canonical column keys in shared mode
   - FKs discovered in one persona automatically apply to all personas
   - Validation ensures columns exist before creating relationships
   - Backward compatible - legacy mode uses original id-based relationships

5. **Cross-Model Discovery (Task 5 - Complete)**
   - Automatic detection of overlapping tables across personas
   - Generates SME questions for cross-model relationship validation
   - Self-overlap filtering prevents false positives
   - Optimized queries (no N+1) with persona details included
   - Non-fatal - persona creation never fails due to discovery errors

6. **Backfill Migration (Task 6 - Complete)**
   - Service to add canonical keys to existing Neo4j nodes
   - Derives databaseId from AgentPersona namespace (handles nodes without databaseId property)
   - Processes Tables, Columns, and Values with proper key formats
   - API endpoints: POST /api/neo4j/backfill-canonical-keys, GET /api/neo4j/backfill-stats
   - E2E tested - successfully adds canonical keys to existing nodes

7. **Deduplication Service (Task 7 - Complete)**
   - Merges duplicate nodes with same canonical keys across personas
   - Comprehensive relationship transfer with type-specific EXISTS checks
   - Handles all relationship types: CONTAINS, HAS_COLUMN, HAS_TABLE, FOREIGN_KEY_TO, MAPS_TO, ANNOTATED_WITH, SIMILAR_TO, RELATED_TO
   - Last-wins merge policy for descriptions using coalesce
   - API endpoints: POST /api/neo4j/deduplicate-nodes, GET /api/neo4j/deduplication-stats
   - E2E tested - successfully merges duplicates without data loss

8. **End-to-End Testing (Task 8 - Complete)**
   - Verified backfill migration adds canonical keys correctly
   - Verified deduplication merges nodes without losing relationships
   - Confirmed UI integration works with no critical errors
   - Performance: Backfill stats API takes ~3.3s (acceptable for Neo4j queries)
   - Security note: Maintenance endpoints currently unauthenticated (local dev only)

### Implementation Complete
All tasks for shared node architecture Phase 1 are complete and production-ready. The system now supports:
- Feature-flagged dual-write mode (NEO4J_USE_CANONICAL_KEYS environment variable)
- Context reuse across personas to reduce LLM costs
- Automatic cross-model relationship discovery
- Migration tools for existing Neo4j data
- Comprehensive testing and validation

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Frontend Architecture
- **Framework**: React 18 with TypeScript, using Vite as the build tool
- **UI Components**: Radix UI primitives with shadcn/ui component library
- **Styling**: Tailwind CSS with custom design tokens and CSS variables
- **State Management**: TanStack Query for server state management, local React state for UI state
- **Routing**: Wouter for lightweight client-side routing
- **Component Structure**: Modular component architecture with separate components for each pipeline stage

## Backend Architecture
- **Runtime**: Node.js with Express.js REST API
- **Language**: TypeScript with ES modules
- **Database ORM**: Drizzle ORM for type-safe database operations
- **API Design**: RESTful endpoints organized by feature domains (connections, databases, tables, analysis)
- **Service Layer**: Modular service architecture with separate services for PostgreSQL analysis, Neo4j operations, Gemini AI integration, statistical analysis, and SME interview management

## Data Storage Solutions
- **Primary Database**: PostgreSQL with Neon serverless hosting
- **Schema Management**: Drizzle migrations with programmatic schema definition
- **Knowledge Graph**: Neo4j for hierarchical relationship storage
- **Session Storage**: PostgreSQL-based session management using connect-pg-simple

## Core Data Models
- **Users**: Authentication and user management
- **Connections**: Multi-type connection management (PostgreSQL, Gemini AI, Neo4j)
- **Databases & Tables**: Schema metadata storage with selection and sampling configuration
- **Columns**: Detailed column metadata with statistical properties
- **Agent Personas**: Top-level business domain groupings
- **SME Questions**: Structured interview questions with response tracking
- **Analysis Jobs**: Asynchronous job tracking for long-running processes

## Authentication and Authorization
- **Session-based Authentication**: Express sessions with PostgreSQL storage
- **User Management**: Basic username/password authentication
- **Multi-tenant Support**: User-scoped data isolation through userId foreign keys

## AI Integration Architecture
- **LLM Provider**: Google Gemini AI for context generation and hypothesis creation
- **AI Services**: Dedicated service layer for AI operations including table/column description generation, join suggestion, and SME question formulation
- **Human-in-the-Loop**: Structured workflow requiring human validation of all AI-generated content

## Knowledge Graph Design
- **Hierarchy**: Four-level structure (Agent Personas → Tables → Columns → Values)
- **Cardinality-based Storage**: Low-cardinality columns (<=100 values) expanded to value nodes, high-cardinality columns (>5000 values) stored as metadata only
- **Relationship Mapping**: Foreign key relationships plus AI-suggested semantic relationships
- **Multi-layered Context**: System metadata, AI-generated descriptions, and human-validated business logic

# External Dependencies

## Database Services
- **Neon PostgreSQL**: Serverless PostgreSQL hosting with connection pooling
- **Neo4j**: Graph database for hierarchical knowledge representation

## AI/ML Services
- **Google Gemini AI**: Large language model for context generation, description creation, and SME question formulation

## Frontend Libraries
- **TanStack Query**: Server state management and caching
- **Radix UI**: Accessible component primitives
- **Tailwind CSS**: Utility-first CSS framework
- **Wouter**: Lightweight routing library

## Backend Libraries
- **Drizzle ORM**: Type-safe PostgreSQL ORM with migration support
- **Express.js**: Web application framework
- **neo4j-driver**: Official Neo4j database driver
- **connect-pg-simple**: PostgreSQL session store

## Development Tools
- **TypeScript**: Type safety across frontend and backend
- **Vite**: Fast development server and build tool
- **ESBuild**: Fast JavaScript bundler for production builds
- **Replit Integration**: Development environment plugins for runtime error handling and debugging