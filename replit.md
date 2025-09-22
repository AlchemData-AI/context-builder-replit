# Overview

This is a sophisticated context builder application for AlchemData, designed to create hierarchical knowledge graphs from database schemas. The system serves as a comprehensive data analysis and documentation platform that combines automated schema discovery, statistical analysis, AI-powered context generation, and human-in-the-loop validation through Subject Matter Expert (SME) interviews.

The application implements a multi-layered approach to building context:
1. Automated system-level metadata extraction from database schemas
2. AI-assisted description generation and relationship discovery
3. Human validation and refinement through structured interviews
4. Knowledge graph construction using Neo4j for hierarchical data representation

The core workflow progresses through database connection validation, schema discovery, sampling configuration, statistical analysis, AI context generation, SME interviews, and finally knowledge graph construction.

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
- **Cardinality-based Storage**: Low-cardinality columns (<50 values) expanded to value nodes, high-cardinality columns (>5000 values) stored as metadata only
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