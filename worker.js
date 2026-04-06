// ══════════════════════════════════════════════════════════════════════════════
// Tether AI Coach — Cloudflare Worker
// Routes: /chat  /get-memory  /save-summary  /adkar  /analyze-themes
// Secrets required: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY,
//                   SUPABASE_SERVICE_KEY, CRON_SECRET
// ══════════════════════════════════════════════════════════════════════════════

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    switch (url.pathname) {
      case '/chat':           return handleChat(request, env);
      case '/get-memory':     return handleGetMemory(request, env);
      case '/save-summary':   return handleSaveSummary(request, env);
      case '/adkar':          return handleAdkar(request, env);
      case '/analyze-themes': return handleAnalyzeThemes(request, env);
      default:
        return jsonResponse({ error: 'Not found' }, 404);
    }
  },

  // Cloudflare Cron Trigger — runs nightly at 2am UTC
  // Schedule in wrangler.toml: crons = ["0 2 * * *"]
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runNightlyAnalysis(env));
  }
};

// ── HANDLER: Chat proxy with date injection ────────────────────────────────
async function handleChat(request, env) {
  try {
    const body = await request.json();

    const today = new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
    const datePrefix = `Today's date is ${today}. Use this as your reference for all date and time reasoning in this conversation.\n\n`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: body.model || 'claude-sonnet-4-5',
        max_tokens: body.max_tokens || 1024,
        system: datePrefix + (body.system || ''),
        messages: body.messages,
      }),
    });

    const data = await response.json();
    return jsonResponse(data, response.status);
  } catch (err) {
    console.error('handleChat error:', err);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}

// ── HANDLER: Get user memory ───────────────────────────────────────────────
async function handleGetMemory(request, env) {
  try {
    const { user_id } = await request.json();
    if (!user_id) return jsonResponse({ error: 'user_id required' }, 400);

    const res = await supabaseGet(env,
      `/rest/v1/session_summaries?user_id=eq.${user_id}&order=created_at.desc&limit=5`
    );
    const summaries = await res.json();
    return jsonResponse({ summaries });
  } catch (err) {
    console.error('handleGetMemory error:', err);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}

// ── HANDLER: Save session summary ─────────────────────────────────────────
async function handleSaveSummary(request, env) {
  try {
    const body = await request.json();
    const res = await supabasePost(env, '/rest/v1/session_summaries', body);
    return jsonResponse({ success: res.ok });
  } catch (err) {
    console.error('handleSaveSummary error:', err);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}

// ── HANDLER: Save ADKAR assessment ────────────────────────────────────────
async function handleAdkar(request, env) {
  try {
    const body = await request.json();
    const res = await supabasePost(env, '/rest/v1/adkar_assessments', body);
    return jsonResponse({ success: res.ok });
  } catch (err) {
    console.error('handleAdkar error:', err);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}

// ── HANDLER: Trigger nightly theme analysis (manual or cron) ──────────────
async function handleAnalyzeThemes(request, env) {
  // Protect this endpoint — only cron or an authorized server call
  const authHeader = request.headers.get('X-Cron-Secret') || '';
  if (authHeader !== env.CRON_SECRET) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }
  await runNightlyAnalysis(env);
  return jsonResponse({ success: true, message: 'Theme analysis complete.' });
}

// ── NIGHTLY ANALYSIS ──────────────────────────────────────────────────────
// 1. Fetch all companies
// 2. For each company, gather session_summaries + messages from last 7 days
// 3. Call Claude to extract anonymized emotional themes and phrases
// 4. Write results to emotional_themes table
async function runNightlyAnalysis(env) {
  try {
    // Get all active companies
    const companiesRes = await supabaseGet(env, '/rest/v1/companies?select=id,name');
    const companies = await companiesRes.json();

    for (const company of companies) {
      await analyzeCompany(company, env);
    }
  } catch (err) {
    console.error('runNightlyAnalysis error:', err);
  }
}

async function analyzeCompany(company, env) {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const since = sevenDaysAgo.toISOString();

  try {
    // ── Gather session summaries ─────────────────────────────────────────
    const summariesRes = await supabaseGet(env,
      `/rest/v1/session_summaries?company_id=eq.${company.id}&created_at=gte.${since}&select=summary_text,emotional_themes,key_concerns`
    );
    const summaries = await summariesRes.json();

    // ── Gather recent messages (employee turns only) ─────────────────────
    const messagesRes = await supabaseGet(env,
      `/rest/v1/messages?company_id=eq.${company.id}&role=eq.user&created_at=gte.${since}&select=content,session_id`
    );
    const messages = await messagesRes.json();

    // Count unique employees via session cross-reference
    const sessionIds = [...new Set(messages.map(m => m.session_id).filter(Boolean))];
    const sessRes = await supabaseGet(env,
      `/rest/v1/sessions?id=in.(${sessionIds.slice(0,200).join(',')})&select=user_id`
    );
    const sessData = sessionIds.length ? await sessRes.json() : [];
    const uniqueEmployeeCount = new Set(sessData.map(s => s.user_id)).size;

    // Need at least 3 sessions worth of data to analyze (privacy minimum for analysis)
    if (summaries.length < 3 && messages.length < 10) {
      console.log(`Company ${company.name}: insufficient data, skipping.`);
      return;
    }

    // ── Build anonymized text corpus ─────────────────────────────────────
    // CRITICAL: We strip all identifying info and send only emotional content
    // Never send raw full messages — only summary fields and short excerpts
    const corpus = buildAnonymizedCorpus(summaries, messages);

    // ── Call Claude for theme extraction ─────────────────────────────────
    const themes = await extractThemes(corpus, env);
    if (!themes) return;

    // ── Write to Supabase ─────────────────────────────────────────────────
    await supabasePost(env, '/rest/v1/emotional_themes', {
      company_id: company.id,
      analyzed_at: new Date().toISOString(),
      employee_count: uniqueEmployeeCount,
      session_count: summaries.length || messages.length,
      themes: themes,
      date_range_from: since,
      date_range_to: new Date().toISOString()
    });

    console.log(`Company ${company.name}: themes written successfully.`);

  } catch (err) {
    console.error(`analyzeCompany error for ${company.name}:`, err);
  }
}

// Build anonymized corpus from session data
// Strips names, IDs, dates — sends only emotional/thematic content
function buildAnonymizedCorpus(summaries, messages) {
  const parts = [];

  // From session summaries — these are already AI-generated and abstracted
  summaries.forEach(s => {
    if (s.summary_text) parts.push(s.summary_text);
    if (s.key_concerns) parts.push(
      Array.isArray(s.key_concerns) ? s.key_concerns.join('. ') : s.key_concerns
    );
    if (s.emotional_themes) parts.push(
      typeof s.emotional_themes === 'string' ? s.emotional_themes : JSON.stringify(s.emotional_themes)
    );
  });

  // From raw messages — include only short excerpts (first 120 chars) to limit exposure
  // This surfaces phrase-level language without reproducing full conversations
  messages.slice(0, 150).forEach(m => {
    if (m.content && typeof m.content === 'string') {
      const excerpt = m.content.trim().slice(0, 120);
      if (excerpt.length > 20) parts.push(excerpt);
    }
  });

  return parts.join('\n---\n');
}

// Call Claude to extract emotional themes and representative phrases
async function extractThemes(corpus, env) {
  const systemPrompt = `You are an organizational psychologist analyzing anonymized employee coaching session data for HR insights.

Your task: identify emotional tone themes present in the data and extract SHORT representative phrases (3–8 words) that exemplify each theme.

CRITICAL PRIVACY RULES:
- Never reproduce full sentences verbatim — always paraphrase or extract short fragments
- Never include anything that could identify a specific person (names, roles, unique situations, specific dates, dollar amounts, project names)
- Phrases must be generic enough that no single employee could be identified
- If a phrase feels too specific, generalize it

THEMES TO IDENTIFY:
1. anxiety — worry, uncertainty, fear about the future
2. resistance — frustration, pushback, skepticism about change  
3. hopeful — engagement, optimism, willingness to adapt
4. exhausted — burnout, overwhelm, depletion
5. disconnected — disengagement, detachment, "just going through motions"

OUTPUT: Respond ONLY with valid JSON in this exact structure:
{
  "anxiety":      { "percentage": <0-100>, "phrases": ["phrase 1", "phrase 2", "phrase 3", "phrase 4", "phrase 5"] },
  "resistance":   { "percentage": <0-100>, "phrases": ["phrase 1", "phrase 2", "phrase 3", "phrase 4", "phrase 5"] },
  "hopeful":      { "percentage": <0-100>, "phrases": ["phrase 1", "phrase 2", "phrase 3", "phrase 4", "phrase 5"] },
  "exhausted":    { "percentage": <0-100>, "phrases": ["phrase 1", "phrase 2", "phrase 3", "phrase 4", "phrase 5"] },
  "disconnected": { "percentage": <0-100>, "phrases": ["phrase 1", "phrase 2", "phrase 3", "phrase 4", "phrase 5"] }
}

Percentages should reflect the RELATIVE PREVALENCE of each theme in the data and must sum to 100.
Phrases should be 3–8 words, emotionally resonant but not personally identifying.
If a theme has minimal representation, return fewer than 5 phrases or an empty array.
Return ONLY the JSON object. No preamble, no explanation, no markdown.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Analyze this anonymized employee session data:\n\n${corpus}` }]
      }),
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);

  } catch (err) {
    console.error('extractThemes error:', err);
    return null;
  }
}

// ── SUPABASE HELPERS ──────────────────────────────────────────────────────
function supabaseGet(env, path) {
  return fetch(`${env.SUPABASE_URL}${path}`, {
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json'
    }
  });
}

function supabasePost(env, path, body) {
  return fetch(`${env.SUPABASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(body)
  });
}

// ── UTIL ──────────────────────────────────────────────────────────────────
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
