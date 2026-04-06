# Tether AI Coach — RAG System Setup Guide

## Architecture Overview

```
User → Cloudflare Worker (tether-proxy) → Voyage AI (embeddings) → Supabase (hybrid search) → Claude API → Response
```

- **Frontend:** Hosted separately (not covered here)
- **Cloudflare Worker:** `tether-proxy` at `https://tether-proxy.john-834.workers.dev` — handles `/chat`, `/get-memory`, `/save-summary`, `/adkar`, `/analyze-themes`, nightly cron
- **Database:** Supabase (project `ylufotpafbmhhjffovpf`, org "Tether Change Management")
- **Embeddings:** Voyage AI `voyage-3-lite` (1024 dimensions)
- **AI Model:** Anthropic Claude Sonnet 4
- **Ingestion:** Local Node.js script (`ingestion/ingest.js`)

> **WARNING:** Do NOT confuse with the Evolved Caveman Supabase project (`osywbzzvsfjdvjhjalju`). They are completely separate.

---

## Prerequisites

- Node.js 18+
- npm
- Wrangler CLI (`npm install -g wrangler`) — for Cloudflare Worker deployment
- Supabase account with access to the Tether project
- Voyage AI API key
- Anthropic API key

---

## 1. Database Setup (Supabase)

Four migrations need to be applied in the Supabase SQL Editor (Dashboard → SQL Editor → New Query):

| Migration | What it does |
|---|---|
| `001_enable_extensions.sql` | Enables `pgvector` and `pg_trgm` extensions |
| `002_create_rag_tables.sql` | Creates `sources` and `chunks` tables with vector(1024), full-text search, ADKAR metadata, indexes, RLS |
| `003_create_retrieval_functions.sql` | Creates 5 retrieval functions: `match_chunks`, `search_chunks_fts`, `hybrid_search`, `get_chunk_neighbors`, `increment_retrieval_count` |
| `004_create_app_tables.sql` | Creates `profiles`, `conversations`, `session_summaries`, `crisis_events`, `consent_events` |

Apply them in order (001 → 002 → 003 → 004).

**Known gotchas:**
- Migration 003: Uses `chunk_position` not `position` (reserved word in Postgres)
- Migration 004: `auth.users` FK references removed for initial setup — add back after auth is configured

---

## 2. Cloudflare Worker (tether-proxy)

The Worker is in the `worker/` subfolder of the GitHub repo.

### Secrets (set via Wrangler):

```bash
cd worker
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put VOYAGE_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY
```

### Deploy:

```bash
cd worker
npx wrangler deploy
```

Worker name: `tether-proxy`
URL: `https://tether-proxy.john-834.workers.dev`

### RAG Pipeline in the Worker:

1. User sends message to `/chat`
2. Worker embeds user query via Voyage AI
3. Calls `hybrid_search` RPC on Supabase (70% vector, 30% full-text via RRF)
4. Expands context with `get_chunk_neighbors`
5. Builds context block for Claude system prompt
6. Sends to Claude API
7. Returns response with `_rag` debug field (chunk count/IDs)

RAG is gracefully skipped when `VOYAGE_API_KEY` is missing or no chunks are found.

---

## 3. Ingestion Pipeline

### Setup:

```bash
cd ingestion
cp .env.example .env
# Fill in your Supabase and Voyage AI credentials in .env
npm install
```

### Content files:

Place `.md` files in `ingestion/content/`. Each file should have YAML front matter:

```yaml
---
title: Your Title Here
type: knowledge_base
pillar: awareness
framework: adkar
content_type: concept
audience: corporate_employees
author: Dr. John Schinnerer
description: Brief description of the content.
keywords: [keyword1, keyword2, keyword3]
---

# Your content here...
```

**ADKAR Pillars:** awareness, desire, knowledge, ability, reinforcement

**Filename fallback:** If no front matter, metadata is extracted from filename format: `type_pillar_slug.md`

### Run:

```bash
# Dry run (parse + chunk, no DB writes)
node ingest.js --dry-run

# Full ingestion
node ingest.js

# Process single file
node ingest.js --file content/my-article.md

# Clean all data and re-ingest
node ingest.js --clean
```

### What it does:

1. Reads each `.md` file from `content/`
2. Parses YAML front matter (falls back to filename metadata)
3. Chunks text at paragraph/section boundaries (~600 token target, 800 max, 15% overlap)
4. SHA-256 hashes file for change detection (skips unchanged files)
5. Generates summary/parent chunk for each document
6. Embeds all chunks via Voyage AI (`voyage-3-lite`, 1024 dimensions)
7. Inserts source record + chunks into Supabase

---

## 4. Testing End-to-End RAG

After ingesting content, test the full pipeline:

```bash
curl -X POST https://tether-proxy.john-834.workers.dev/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Why is change so hard for people?",
    "userId": "test-user-001"
  }'
```

Check the `_rag` field in the response to verify chunks were retrieved.

---

## 5. GitHub Repository

Repo: `https://github.com/johnschin/tether-ai-coach`

### Key files:

```
tether-ai-coach/
├── worker/
│   ├── worker.js          ← Cloudflare Worker (deployed)
│   └── wrangler.toml
├── migrations/
│   ├── 001_enable_extensions.sql
│   ├── 002_create_rag_tables.sql
│   ├── 003_create_retrieval_functions.sql
│   └── 004_create_app_tables.sql
├── ingestion/
│   ├── ingest.js          ← Ingestion pipeline
│   ├── package.json
│   ├── .env.example
│   └── content/           ← Place .md content files here
└── SETUP_GUIDE.md
```

---

## Pending Items

- [ ] Add `auth.users` FK references back to app tables (after auth is configured)
- [ ] Clean up orphan test data (source id: `af7544f9...`)
- [ ] Configure user-level RLS policies (currently service-role-only)
