# Statistical Analysis Flow

## Overview
Automated column-level analysis using **1K row sampling** to understand data distribution, cardinality, and patterns for building a knowledge graph. Analyzes large tables efficiently with minimal database load.

## Sampling Strategy

### Three Sample Types
1. **Sample 1 (Top 1K):** First 1000 rows ordered by primary key ASC
2. **Sample 2 (Bottom 1K):** Last 1000 rows ordered by primary key DESC
3. **Sample 3+ (Random 1K):** Random 1000 rows at calculated offsets

### Progressive Analysis
- Each click of "Analyze" runs the next sample
- Button shows: "Analyze Top 1K" → "Analyze Bottom 1K" → "Analyze Random 1K #1" → ...
- Tracks `samplesAnalyzed` count and `lastSampleStrategy` per table

## Process Steps

### 1. Trigger Analysis
- User clicks "Analyze [Strategy]" button in UI
- Frontend sends request to `/api/tables/{tableId}/analyze-statistics`
- Backend auto-determines sample strategy based on `samplesAnalyzed` count

### 2. Database Connection
- Backend connects to PostgreSQL using stored connection config
- Connection pooling managed by `postgres-analyzer`

### 3. Fetch Sample Data (Single Query)
**One query fetches all 1K rows with all columns:**

```sql
-- Top 1K
SELECT * FROM schema.table ORDER BY primary_key ASC LIMIT 1000

-- Bottom 1K
SELECT * FROM schema.table ORDER BY primary_key DESC LIMIT 1000

-- Random 1K (with offset)
SELECT * FROM schema.table ORDER BY primary_key ASC LIMIT 1000 OFFSET {offset}
```

**Fallback:** Uses `ctid` if no primary key exists

### 4. In-Memory Column Analysis
**All calculations performed on the 1K sample in memory:**

For each column:
- **Cardinality:** `new Set(values).size`
- **Null %:** `(nullCount / 1000) * 100`
- **Min/Max:** `Math.min/max()` for numeric columns
- **Distinct Values:** `Array.from(new Set(values))`
- **Pattern Detection:** Email, URL, phone regex matching

### 5. Pattern Recognition
Automated analysis identifies:
- **Low cardinality** (≤100 unique values) → Categorical/Enum candidates
- **High null** (>40%) → Potentially optional fields
- **Numeric patterns** → Range distribution, constant values
- **Text patterns** → Email, URL, phone number detection
- **Unique values** → Primary key candidates

### 6. Column Categorization
Columns are grouped into:
- `lowCardinalityColumns` - Suitable for enum expansion
- `highNullColumns` - Need SME clarification
- `numericColumns` - With min/max ranges
- `categoricalColumns` - For knowledge graph nodes
- `potentialJoinColumns` - Ending in `_id` or named `id`

### 7. Store Results
- Column statistics saved to database via `storage.updateColumnStats()`
- Table metadata updated: `samplesAnalyzed++`, `lastSampleStrategy`
- Includes: cardinality, null%, min/max, distinct values (all from 1K sample)

### 8. Generate Summary
- Aggregate statistics across all tables
- Calculate completion percentage
- Identify patterns and recommendations
- Return summary to frontend

### 9. Display Results
Frontend shows:
- Sample count badge: "Samples: 2"
- Dynamic button: "Analyze Top 1K" / "Analyze Bottom 1K" / "Analyze Random 1K #N"
- Sample info card showing last strategy used
- Overall progress and key findings
- Analysis log

## Performance Benefits
- **1 query instead of N queries** (where N = column count)
- **No full table scans** on large tables
- **In-memory calculations** are fast
- **Progressive sampling** allows multiple perspectives on data
- Example: 6M row table with 50 columns
  - Old: 50+ queries scanning millions of rows
  - New: 1 query fetching 1K rows

## Key Files
- `shared/schema.ts` - Database schema with sampling fields
- `server/services/postgres-analyzer.ts` - Sample fetching (getPrimaryKeyColumn, fetchSampleRows)
- `server/services/statistical-analyzer.ts` - In-memory analysis (calculateColumnStats)
- `server/routes.ts` - Auto-determine sample strategy
- `server/storage.ts` - updateTable method
- `client/src/components/StatisticalAnalysis.tsx` - UI with sample tracking
