/**
 * Tether AI Coach — Cloudflare Worker (tether-proxy)
 *
 * RAG-enhanced proxy matched to actual Tether Supabase schema
 * (project ylufotpafbmhhjffovpf).
 *
 * Routes:
 *   /chat          — Main chat endpoint with RAG retrieval
 *   /get-memory    — Retrieve session summaries
 *   /save-summary  — Save session summary
 *   /adkar         — ADKAR stage assessment
 *   /analyze-themes — Theme analysis across sessions
 *   /health        — Health check
 *   Nightly cron   — Scheduled maintenance
 *
 * RAG Pipeline:
 *   1. Embed user query via Voyage AI (voyage-3-lite, 1024d)
 *   2. Hybrid search on Supabase (70% vector / 30% FTS via RRF)
 *   3. Context expansion with get_chunk_neighbors
 *   4. Build context block for Claude system prompt
 *   5. Return response with _rag debug field
 *
 * Deployed: https://tether-proxy.john-834.workers.dev
 * Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VOYAGE_API_KEY, ANTHROPIC_API_KEY
 */

const VOYAGE_MODEL = 'voyage-3-lite';
const VOYAGE_EMBED_URL = 'https://api.voyageai.com/v1/embeddings';
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

// ─── CORS Headers ────────────────────────────────────────────────────────────

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// ─── Crisis Detection ────────────────────────────────────────────────────────

const CRISIS_KEYWORDS = [
  'suicide', 'suicidal', 'kill myself', 'end my life', 'want to die',
  'self-harm', 'self harm', 'cutting myself', 'hurt myself',
  'no reason to live', 'better off dead', "can't go on",
];

function detectCrisisKeywords(message) {
  const lower = message.toLowerCase();
  return CRISIS_KEYWORDS.some(kw => lower.includes(kw));
}

const CRISIS_RESPONSE = `I hear you, and I want you to know that what you're feeling matters. What you've shared is beyond what I'm designed to help with — this calls for a real person who's trained in crisis support.

Please reach out now:
- **988 Suicide & Crisis Lifeline:** Call or text 988 (US)
- **Crisis Text Line:** Text HOME to 741741
- **International Association for Suicide Prevention:** https://www.iasp.info/resources/Crisis_Centres/

You don't have to go through this alone. A trained counselor can help right now.

*Tether is a coaching tool for self-leadership and personal development. It is not therapy, counseling, or crisis support.*`;

// ─── Supabase Helpers ────────────────────────────────────────────────────────

function supabaseFetch(env, path, options = {}) {
  const url = `${env.SUPABASE_URL}/rest/v1/${path}`;
  return fetch(url, {
    ...options,
    headers: {
      'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': options.prefer || 'return=representation',
      ...options.headers,
    },
  });
}

function supabaseRpc(env, functionName, params = {}) {
  const url = `${env.SUPABASE_URL}/rest/v1/rpc/${functionName}`;
  return fetch(url, {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });
}

// ─── Voyage AI Embedding ─────────────────────────────────────────────────────

async function embedQuery(text, env) {
  const response = await fetch(VOYAGE_EMBED_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.VOYAGE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: VOYAGE_MODEL,
      input: [text],
      input_type: 'query',
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    console.error(`Voyage AI error (${response.status}):`, errBody);
    return null;
  }

  const data = await response.json();
  return data.data[0].embedding;
}

// ─── RAG Retrieval Pipeline ──────────────────────────────────────────────────

async function retrieveContext(userMessage, env) {
  if (!env.VOYAGE_API_KEY) {
    console.log('RAG skipped: no VOYAGE_API_KEY');
    return { context: '', chunkCount: 0, chunkIds: [] };
  }

  try {
    // Step 1: Embed user query
    const queryEmbedding = await embedQuery(userMessage, env);
    if (!queryEmbedding) {
      console.log('RAG skipped: embedding failed');
      return { context: '', chunkCount: 0, chunkIds: [] };
    }

    // Step 2: Hybrid search — matches ACTUAL function signature:
    // hybrid_search(query_embedding, search_query, match_count, vector_weight,
    //   fts_weight, rrf_k, filter_pillar, filter_framework, filter_audience,
    //   filter_chunk_level)
    const searchResponse = await supabaseRpc(env, 'hybrid_search', {
      query_embedding: JSON.stringify(queryEmbedding),
      search_query: userMessage,
      match_count: 5,
      vector_weight: 0.7,
      fts_weight: 0.3,
      rrf_k: 60,
      filter_pillar: null,
      filter_framework: null,
      filter_audience: null,
      filter_chunk_level: null,
    });

    if (!searchResponse.ok) {
      const errText = await searchResponse.text();
      console.error('Hybrid search error:', errText);
      return { context: '', chunkCount: 0, chunkIds: [] };
    }

    const chunks = await searchResponse.json();

    if (!chunks || chunks.length === 0) {
      console.log('RAG: no chunks matched');
      return { context: '', chunkCount: 0, chunkIds: [] };
    }

    // Step 3: Expand context with neighbors for top 3
    // Actual function: get_chunk_neighbors(chunk_id, neighbor_count)
    const expandedChunks = [];
    const seenIds = new Set();

    for (const chunk of chunks.slice(0, 3)) {
      const neighborsResponse = await supabaseRpc(env, 'get_chunk_neighbors', {
        chunk_id: chunk.id,
        neighbor_count: 1,
      });

      if (neighborsResponse.ok) {
        const neighbors = await neighborsResponse.json();
        for (const n of neighbors) {
          if (!seenIds.has(n.id)) {
            seenIds.add(n.id);
            expandedChunks.push({ ...n, pillar: chunk.pillar });
          }
        }
      } else {
        if (!seenIds.has(chunk.id)) {
          seenIds.add(chunk.id);
          expandedChunks.push(chunk);
        }
      }
    }

    // Add remaining non-expanded chunks
    for (const chunk of chunks.slice(3)) {
      if (!seenIds.has(chunk.id)) {
        seenIds.add(chunk.id);
        expandedChunks.push(chunk);
      }
    }

    // Step 4: Build context block
    const contextBlock = expandedChunks
      .map((c, i) => `[Source ${i + 1}${c.pillar ? ` | ${c.pillar}` : ''}]\n${c.content}`)
      .join('\n\n---\n\n');

    const chunkIds = chunks.map(c => c.id);

    // Step 5: Increment retrieval counts (fire and forget)
    supabaseRpc(env, 'increment_retrieval_count', { chunk_ids: chunkIds }).catch(() => {});

    return {
      context: contextBlock,
      chunkCount: chunks.length,
      chunkIds,
    };
  } catch (err) {
    console.error('RAG retrieval error:', err.message);
    return { context: '', chunkCount: 0, chunkIds: [] };
  }
}

// ─── System Prompt ───────────────────────────────────────────────────────────

function buildSystemPrompt(ragContext, userContext = {}) {
  const basePrompt = `You are Tether — an AI coaching tool that helps corporate employees navigate organizational change, layoffs, AI adoption, and workplace psychological pressures.

You are built on the PROSCI ADKAR change management model combined with psychological coaching principles from Dr. John Schinnerer and Joree Rose.

YOUR VOICE:
- Warm, direct, slightly irreverent, grounded in science but delivered conversationally
- Think: your smartest friend who has a PhD and won't let you off the hook
- Not a neutral chatbot voice — you have personality and care

YOUR COACHING APPROACH:
1. Name the pattern or tension the person is experiencing
2. Ask ONE sharp coaching question (not three — one)
3. Offer one practical reframe
4. Suggest one concrete next step

ADKAR FRAMEWORK:
- Awareness: Understanding WHY the change is happening
- Desire: Building personal motivation to support the change
- Knowledge: Learning HOW to change (skills, behaviors, processes)
- Ability: Implementing the change in practice
- Reinforcement: Sustaining the change over time

HARD BOUNDARIES:
- You are NOT therapy, counseling, or crisis support
- You are NOT a substitute for a licensed mental health professional
- Never diagnose conditions or recommend medications
- Never explore trauma or abuse memories
- If someone is in crisis, immediately provide crisis resources and stop coaching
- You are educational coaching for self-leadership and professional development

COACHING LANGUAGE (use these):
Pattern, operating strategy, default response, leadership habit, automatic script, performance cost, relationship impact, self-command, self-leadership, awareness, accountability, values alignment, next step, decision point

AVOID AS PRIMARY LANGUAGE:
Trauma, healing old wounds, childhood wounds, diagnosis, treatment, mental disorder language, therapeutic intervention

FORMATTING RULES:
- Never use asterisks (*) in your responses — no bold, no italic, no bullet markers using asterisks
- Never use hashtags (#) in your responses — no markdown headers
- Use plain, clean text. Use dashes (-) for lists if needed. Emphasize through word choice and sentence structure, not formatting symbols.

GREETING RULES:
- Only say "Welcome back" when the user is returning (i.e., they have prior session history or memory context)
- For first-time users, use a fresh introduction like: "Hi — I'm Tether, your resilience coach. I'm here to help you navigate whatever's shifting at work right now. What's on your mind?"
- Do not assume a user has been here before unless session memory confirms it`;

  let prompt = basePrompt;

  if (ragContext) {
    prompt += `\n\n---\n\nRELEVANT KNOWLEDGE (use naturally, don't quote directly):\n\n${ragContext}`;
  }

  if (userContext.adkarStage) {
    prompt += `\n\nUser's current ADKAR stage: ${userContext.adkarStage}. Tailor your coaching to this stage.`;
  }

  if (userContext.sessionSummary) {
    prompt += `\n\nPrevious session context: ${userContext.sessionSummary}`;
  }

  return prompt;
}

// ─── Route: /chat ────────────────────────────────────────────────────────────

async function handleChat(request, env) {
  const body = await request.json();
  const { message, userId, sessionId, system, conversationHistory = [] } = body;

  if (!message) {
    return jsonResponse({ error: 'Message is required' }, 400);
  }

  // Crisis detection (keyword-based)
  if (detectCrisisKeywords(message)) {
    // Log crisis event — matches actual crisis_events schema
    try {
      await supabaseFetch(env, 'crisis_events', {
        method: 'POST',
        body: JSON.stringify({
          session_id: sessionId || null,
          user_id: userId || null,
          user_message: message.slice(0, 2000),
          detection_method: 'keyword',
          keyword_triggers: CRISIS_KEYWORDS.filter(kw => message.toLowerCase().includes(kw)),
          severity: 'high',
          assistant_message: CRISIS_RESPONSE.slice(0, 2000),
        }),
      });
    } catch (e) {
      console.error('Failed to log crisis event:', e.message);
    }

    return jsonResponse({
      response: CRISIS_RESPONSE,
      _crisis: true,
      _rag: { chunkCount: 0, chunkIds: [] },
    });
  }

  // RAG retrieval
  const rag = await retrieveContext(message, env);

  // Get session memory if userId provided
  let sessionSummary = null;
  if (userId) {
    try {
      const memResponse = await supabaseFetch(env,
        `session_summaries?user_id=eq.${userId}&order=created_at.desc&limit=1`,
        { method: 'GET' }
      );
      if (memResponse.ok) {
        const summaries = await memResponse.json();
        if (summaries.length > 0) {
          sessionSummary = summaries[0].summary;
        }
      }
    } catch (e) {
      console.error('Memory retrieval failed:', e.message);
    }
  }

  // Build system prompt
  const systemPrompt = system || buildSystemPrompt(rag.context, { sessionSummary });

  // Build messages array
  const messages = [];
  for (const msg of conversationHistory) {
    messages.push({ role: msg.role, content: msg.content });
  }
  messages.push({ role: 'user', content: message });

  // Call Claude API
  const claudeResponse = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    }),
  });

  if (!claudeResponse.ok) {
    const errBody = await claudeResponse.text();
    console.error(`Claude API error (${claudeResponse.status}):`, errBody);
    return jsonResponse({ error: 'AI service error', details: errBody }, 502);
  }

  const claudeData = await claudeResponse.json();
  const assistantMessage = claudeData.content[0].text;

  // AI-based crisis classification on response (secondary check)
  const lowerResponse = assistantMessage.toLowerCase();
  const aiCrisisDetected = lowerResponse.includes('988') || lowerResponse.includes('crisis line');

  if (aiCrisisDetected && (userId || sessionId)) {
    try {
      await supabaseFetch(env, 'crisis_events', {
        method: 'POST',
        body: JSON.stringify({
          session_id: sessionId || null,
          user_id: userId || null,
          user_message: message.slice(0, 2000),
          detection_method: 'ai_classified',
          severity: 'medium',
          assistant_message: assistantMessage.slice(0, 2000),
        }),
      });
    } catch (e) {
      console.error('Failed to log AI-classified crisis:', e.message);
    }
  }

  // Save conversation — matches actual conversations schema
  // (session_id, user_id, user_message, assistant_message, retrieved_chunk_ids, metadata)
  if (sessionId || userId) {
    try {
      await supabaseFetch(env, 'conversations', {
        method: 'POST',
        body: JSON.stringify({
          session_id: sessionId || crypto.randomUUID(),
          user_id: userId || null,
          user_message: message,
          assistant_message: assistantMessage,
          retrieved_chunk_ids: rag.chunkIds,
          metadata: { rag_chunk_count: rag.chunkCount },
        }),
      });
    } catch (e) {
      console.error('Failed to save conversation:', e.message);
    }
  }

  return jsonResponse({
    response: assistantMessage,
    _rag: {
      chunkCount: rag.chunkCount,
      chunkIds: rag.chunkIds,
    },
  });
}

// ─── Route: /get-memory ──────────────────────────────────────────────────────

async function handleGetMemory(request, env) {
  const { userId } = await request.json();
  if (!userId) return jsonResponse({ error: 'userId required' }, 400);

  const response = await supabaseFetch(env,
    `session_summaries?user_id=eq.${userId}&order=created_at.desc&limit=5`,
    { method: 'GET' }
  );

  if (!response.ok) {
    return jsonResponse({ error: 'Failed to retrieve memory' }, 500);
  }

  const summaries = await response.json();
  return jsonResponse({ summaries });
}

// ─── Route: /save-summary ────────────────────────────────────────────────────

async function handleSaveSummary(request, env) {
  const { userId, sessionId, summary, title, pillar, topics, messageCount } = await request.json();
  if (!userId || !sessionId || !summary) {
    return jsonResponse({ error: 'userId, sessionId, and summary required' }, 400);
  }

  // Matches actual session_summaries schema
  const response = await supabaseFetch(env, 'session_summaries', {
    method: 'POST',
    body: JSON.stringify({
      user_id: userId,
      session_id: sessionId,
      title: title || 'Coaching Session',
      summary,
      pillar: pillar || null,
      topics: topics || [],
      message_count: messageCount || 0,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    return jsonResponse({ error: 'Failed to save summary', details: errText }, 500);
  }

  return jsonResponse({ success: true });
}

// ─── Route: /adkar ───────────────────────────────────────────────────────────

async function handleAdkar(request, env) {
  const { userId, sessionId, message, companyId } = await request.json();
  if (!message) return jsonResponse({ error: 'message required' }, 400);

  const assessResponse = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 256,
      system: `You are an ADKAR change management assessor. Based on the user's message, assess their current ADKAR scores (1-5 each). Respond with ONLY a JSON object: {"awareness_score": 1-5, "desire_score": 1-5, "knowledge_score": 1-5, "ability_score": 1-5, "reinforcement_score": 1-5, "lowest_stage": "awareness|desire|knowledge|ability|reinforcement", "coaching_focus": "brief recommendation"}`,
      messages: [{ role: 'user', content: message }],
    }),
  });

  if (!assessResponse.ok) {
    return jsonResponse({ error: 'Assessment failed' }, 502);
  }

  const assessData = await assessResponse.json();
  let assessment;
  try {
    assessment = JSON.parse(assessData.content[0].text);
  } catch {
    assessment = { awareness_score: 3, desire_score: 3, knowledge_score: 3, ability_score: 3, reinforcement_score: 3, lowest_stage: 'awareness', coaching_focus: 'Could not parse assessment' };
  }

  // Save to adkar_assessments table if userId provided
  if (userId) {
    try {
      await supabaseFetch(env, 'adkar_assessments', {
        method: 'POST',
        body: JSON.stringify({
          user_id: userId,
          session_id: sessionId || null,
          company_id: companyId || null,
          change_context: 'general',
          ...assessment,
        }),
      });
    } catch (e) {
      console.error('Failed to save ADKAR assessment:', e.message);
    }
  }

  return jsonResponse({ assessment });
}

// ─── Route: /analyze-themes ──────────────────────────────────────────────────

async function handleAnalyzeThemes(request, env) {
  const { userId } = await request.json();
  if (!userId) return jsonResponse({ error: 'userId required' }, 400);

  // Get recent conversations — actual schema has user_message column
  const convResponse = await supabaseFetch(env,
    `conversations?user_id=eq.${userId}&order=created_at.desc&limit=20&select=user_message`,
    { method: 'GET' }
  );

  if (!convResponse.ok) {
    return jsonResponse({ error: 'Failed to fetch conversations' }, 500);
  }

  const conversations = await convResponse.json();
  if (conversations.length === 0) {
    return jsonResponse({ themes: [], message: 'No conversation history found' });
  }

  const userMessages = conversations.map(c => c.user_message).join('\n\n');

  const themeResponse = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 512,
      system: `Analyze the following user messages from a change management coaching context. Identify recurring themes, patterns, and ADKAR stage indicators. Respond with JSON: {"themes": ["theme1", "theme2"], "primary_adkar_stage": "stage", "patterns": ["pattern1"], "recommendation": "brief coaching recommendation"}`,
      messages: [{ role: 'user', content: userMessages }],
    }),
  });

  if (!themeResponse.ok) {
    return jsonResponse({ error: 'Theme analysis failed' }, 502);
  }

  const themeData = await themeResponse.json();
  let analysis;
  try {
    analysis = JSON.parse(themeData.content[0].text);
  } catch {
    analysis = { themes: [], patterns: [], recommendation: 'Could not parse analysis' };
  }

  return jsonResponse({ analysis });
}

// ─── Nightly Cron ────────────────────────────────────────────────────────────

async function handleCron(env) {
  console.log('Running nightly maintenance cron...');
  return new Response('OK');
}

// ─── Router ──────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      switch (path) {
        case '/chat':
          return handleChat(request, env);
        case '/get-memory':
          return handleGetMemory(request, env);
        case '/save-summary':
          return handleSaveSummary(request, env);
        case '/adkar':
          return handleAdkar(request, env);
        case '/analyze-themes':
          return handleAnalyzeThemes(request, env);
        case '/health':
          return jsonResponse({ status: 'ok', rag: !!env.VOYAGE_API_KEY });
        default:
          return jsonResponse({ error: 'Not found' }, 404);
      }
    } catch (err) {
      console.error('Unhandled error:', err.message);
      return jsonResponse({ error: 'Internal server error' }, 500);
    }
  },

  async scheduled(event, env) {
    return handleCron(env);
  },
};
