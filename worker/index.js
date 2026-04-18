// ─── Tether AI Coach — Cloudflare Worker (HARDENED v2, ES256) ───────────────
// Destination in repo: tether-ai-coach/worker/index.js
//
// Changes from prior version (JWT hardening, Phase 1):
//   1. Every application endpoint now requires a valid Supabase session JWT
//      in the Authorization header (`Bearer <access_token>`).
//   2. userId is sourced from the JWT's `sub` claim — NEVER from the request
//      body. Any body-supplied userId is IGNORED. This closes the gap where
//      anyone with a UUID could read/write another user's data.
//   3. 401 on missing/malformed/expired/invalid-signature tokens.
//
// Note on signing algorithm:
//   This Supabase project uses ASYMMETRIC signing (ES256 / ECDSA P-256),
//   verified via the project's JWKS endpoint at:
//     {SUPABASE_URL}/auth/v1/.well-known/jwks.json
//   There is NO shared JWT secret for this project — the worker fetches
//   the public keys at runtime and caches them in memory. jose's
//   createRemoteJWKSet handles the fetch + cache + on-demand refresh.
//
// Required env vars (unchanged from prior deploy):
//   - TETHER_ALLOWED_ORIGIN
//   - ANTHROPIC_API_KEY
//   - SUPABASE_URL          ← also used to construct the JWKS URL
//   - SUPABASE_SERVICE_KEY
//   (No new secrets needed — JWKS is a public endpoint.)
//
// New npm dependency:
//   - jose  (standard JOSE library for Workers)
//     Install with: `cd worker && npm install jose`

import { createRemoteJWKSet, jwtVerify } from 'jose';

const CORS_HEADERS = {
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// ─── JWKS cache ─────────────────────────────────────────────────────────────
// Module-level cache. createRemoteJWKSet returns a resolver function that
// internally caches fetched JWKs and refreshes them on demand (default 30min
// cache, automatic refresh if a new kid is seen). We only need to build this
// once per worker isolate — subsequent requests reuse the same resolver.
let _jwks = null;
function getJWKS(supabaseUrl) {
  if (!_jwks) {
    _jwks = createRemoteJWKSet(
      new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`)
    );
  }
  return _jwks;
}

// ─── Auth helper ────────────────────────────────────────────────────────────
// Verifies the Supabase session JWT from the Authorization header.
// Returns { userId, email, claims } on success, or { error, status } on failure.
// Never logs the token. Never echoes the raw jose error to the client.
async function verifyAuth(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { error: 'Missing Authorization header', status: 401 };
  }
  const token = authHeader.slice(7).trim();
  if (!token) {
    return { error: 'Empty bearer token', status: 401 };
  }

  // Fail closed if SUPABASE_URL isn't configured — we can't build the JWKS URL.
  if (!env.SUPABASE_URL) {
    console.error('[auth] SUPABASE_URL is not configured');
    return { error: 'Server not configured for authentication', status: 500 };
  }

  try {
    const JWKS = getJWKS(env.SUPABASE_URL);
    // Supabase access tokens (this project, asymmetric signing):
    //   alg: ES256 (ECDSA with P-256 curve)
    //   aud: "authenticated" (for signed-in users)
    //   iss: <SUPABASE_URL>/auth/v1
    //   sub: <user UUID>
    //   exp: epoch seconds — jose enforces this automatically
    const { payload } = await jwtVerify(token, JWKS, {
      audience: 'authenticated',
      algorithms: ['ES256']
    });
    if (!payload.sub) {
      return { error: 'Token missing sub claim', status: 401 };
    }
    return {
      userId: payload.sub,
      email: payload.email || null,
      claims: payload
    };
  } catch (e) {
    // Common causes: ERR_JWT_EXPIRED, ERR_JWT_CLAIM_VALIDATION_FAILED,
    // ERR_JWS_SIGNATURE_VERIFICATION_FAILED, ERR_JWS_INVALID,
    // ERR_JWKS_NO_MATCHING_KEY (token signed with a kid we haven't cached yet
    // — jose auto-refreshes and retries, so a sustained failure here means
    // something is genuinely wrong).
    // Log the code/name server-side for debugging; return vague error to client.
    console.warn('[auth] JWT verification failed:', e.code || e.name || e.message);
    return { error: 'Invalid or expired token', status: 401 };
  }
}

// ─── Entry point ────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const corsOrigin = env.TETHER_ALLOWED_ORIGIN || '*';

    // CORS preflight — never requires auth.
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          ...CORS_HEADERS,
          'Access-Control-Allow-Origin': corsOrigin
        }
      });
    }

    const corsHeader = {
      'Access-Control-Allow-Origin': corsOrigin,
      'Content-Type': 'application/json'
    };

    const { pathname } = new URL(request.url);

    // All application endpoints require a valid Supabase session JWT.
    // We gate here (before route dispatch) so no handler can forget to check.
    const auth = await verifyAuth(request, env);
    if (auth.error) {
      return new Response(
        JSON.stringify({ error: auth.error }),
        { status: auth.status, headers: corsHeader }
      );
    }

    try {
      if (pathname === '/chat')         return handleChat(request, env, corsHeader, auth);
      if (pathname === '/get-memory')   return handleGetMemory(request, env, corsHeader, auth);
      if (pathname === '/save-summary') return handleSaveSummary(request, env, corsHeader, auth);
      if (pathname === '/adkar')        return handleAdkar(request, env, corsHeader, auth);
      return new Response(
        JSON.stringify({ error: 'Not found' }),
        { status: 404, headers: corsHeader }
      );
    } catch (err) {
      console.error('[handler] unhandled error:', err);
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 500, headers: corsHeader }
      );
    }
  }
};

// ─── /chat ──────────────────────────────────────────────────────────────────
async function handleChat(request, env, corsHeader, auth) {
  const { messages, memoryContext } = await request.json();
  const systemPrompt = buildSystemPrompt(memoryContext);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: systemPrompt,
      messages
    })
  });
  const data = await response.json();
  return new Response(JSON.stringify(data), { headers: corsHeader });
}

// ─── /get-memory ────────────────────────────────────────────────────────────
async function handleGetMemory(request, env, corsHeader, auth) {
  // SECURITY: userId comes from the verified JWT — NOT from the request body.
  // Any body-supplied userId is ignored. This is the core of the hardening.
  const userId = auth.userId;

  const summariesRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/session_summaries?user_id=eq.${userId}&order=session_date.desc&limit=5`,
    {
      headers: {
        'apikey': env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    }
  );
  const summaries = await summariesRes.json();

  const profileRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/user_memory_profile?user_id=eq.${userId}`,
    {
      headers: {
        'apikey': env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    }
  );
  const profile = await profileRes.json();

  const adkarRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/adkar_assessments?user_id=eq.${userId}&order=assessed_at.desc&limit=1`,
    {
      headers: {
        'apikey': env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    }
  );
  const adkar = await adkarRes.json();

  // Preferred name lives on user_profiles (populated by the on_auth_user_created
  // trigger from raw_user_meta_data at signup, and by enterApp() belt-and-suspenders
  // upsert). NULL for users who signed up before Phase B or never entered a name.
  const profileNameRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/user_profiles?id=eq.${userId}&select=preferred_name`,
    {
      headers: {
        'apikey': env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    }
  );
  const profileNameRows = await profileNameRes.json();
  const preferredName = profileNameRows[0]?.preferred_name || null;

  const memoryContext = buildMemoryContext(summaries, profile[0], adkar[0], preferredName);
  return new Response(
    JSON.stringify({ memoryContext }),
    { headers: corsHeader }
  );
}

// ─── /save-summary ──────────────────────────────────────────────────────────
async function handleSaveSummary(request, env, corsHeader, auth) {
  // SECURITY: userId from JWT. Body-supplied userId is ignored.
  const { conversation } = await request.json();
  const userId = auth.userId;

  const summaryRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Summarize this coaching session in 3-5 concise bullet points.
Focus on: key themes discussed, emotional state, tools used, any commitments made.
Be concise. No verbatim quotes. Return ONLY valid JSON, no markdown, no backticks.

Format:
{
  "summary": "bullet point summary as single string",
  "themes": ["theme1", "theme2"],
  "tools_used": ["tool1"],
  "emotional_tone": "distressed|neutral|hopeful|mixed"
}

Valid themes: job_insecurity, burnout, ai_anxiety, survivor_guilt,
identity, relationships, performance, psychological_safety, change_resistance

Conversation:
${conversation}`
      }]
    })
  });
  const summaryData = await summaryRes.json();

  let parsed;
  try {
    const text = summaryData.content[0].text.trim();
    parsed = JSON.parse(text);
  } catch (e) {
    parsed = {
      summary: 'Session completed',
      themes: [],
      tools_used: [],
      emotional_tone: 'neutral'
    };
  }

  await fetch(`${env.SUPABASE_URL}/rest/v1/session_summaries`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`
    },
    body: JSON.stringify({
      user_id: userId,
      summary: parsed.summary,
      themes: parsed.themes,
      tools_used: parsed.tools_used,
      emotional_tone: parsed.emotional_tone
    })
  });

  return new Response(
    JSON.stringify({ success: true }),
    { headers: corsHeader }
  );
}

// ─── /adkar ─────────────────────────────────────────────────────────────────
async function handleAdkar(request, env, corsHeader, auth) {
  // SECURITY: userId from JWT. Body-supplied userId is ignored.
  const { scores, changeContext } = await request.json();
  const userId = auth.userId;

  const stages = ['awareness', 'desire', 'knowledge', 'ability', 'reinforcement'];
  let lowestStage = stages[0];
  let lowestScore = scores.awareness;
  stages.forEach((stage) => {
    if (scores[stage] < lowestScore) {
      lowestScore = scores[stage];
      lowestStage = stage;
    }
  });

  await fetch(`${env.SUPABASE_URL}/rest/v1/adkar_assessments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`
    },
    body: JSON.stringify({
      user_id: userId,
      change_context: changeContext || 'general',
      awareness_score: scores.awareness,
      desire_score: scores.desire,
      knowledge_score: scores.knowledge,
      ability_score: scores.ability,
      reinforcement_score: scores.reinforcement,
      lowest_stage: lowestStage
    })
  });

  return new Response(
    JSON.stringify({ success: true, lowestStage }),
    { headers: corsHeader }
  );
}

// ─── Memory context ─────────────────────────────────────────────────────────
// Builds the context block prepended to the system prompt. Includes the
// employee's preferred name (when known) and any prior-session coaching
// history. Either is enough to produce a non-empty context — a first-time
// user with a known name still gets a personalized greeting.
function buildMemoryContext(summaries, profile, adkar, preferredName) {
  const hasHistory = !!(summaries?.length || profile || adkar);
  if (!hasHistory && !preferredName) return '';

  let context = '';

  if (preferredName) {
    context += `EMPLOYEE PREFERRED NAME: ${preferredName}\n\n`;
  }

  if (hasHistory) {
    context += 'COACHING HISTORY FOR THIS EMPLOYEE:\n\n';
  }

  if (summaries?.length) {
    context += 'Recent sessions:\n';
    summaries.forEach((s) => {
      const date = s.session_date?.split('T')[0] || 'recent';
      context += `- ${date}: ${s.summary}\n`;
      if (s.themes?.length) context += `  Themes: ${s.themes.join(', ')}\n`;
      if (s.emotional_tone) context += `  Tone: ${s.emotional_tone}\n`;
    });
    context += '\n';
  }

  if (adkar) {
    context += `ADKAR CHANGE READINESS (last assessed):\n`;
    context += `- Awareness: ${adkar.awareness_score}/5\n`;
    context += `- Desire: ${adkar.desire_score}/5\n`;
    context += `- Knowledge: ${adkar.knowledge_score}/5\n`;
    context += `- Ability: ${adkar.ability_score}/5\n`;
    context += `- Reinforcement: ${adkar.reinforcement_score}/5\n`;
    context += `- Current bottleneck: ${adkar.lowest_stage}\n\n`;
  }

  if (profile?.coaching_notes) {
    context += `Longitudinal coaching notes:\n${profile.coaching_notes}\n\n`;
  }

  if (hasHistory) {
    context += `Use this history to provide continuity. Reference prior sessions naturally when relevant. Do not recite this history back verbatim.`;
  }

  return context;
}

// ─── System prompt (unchanged) ──────────────────────────────────────────────
function buildSystemPrompt(memoryContext) {
  return `You are Tether, an AI psychological resilience coach for employees in corporate environments. You are warm, direct, and psychologically sophisticated — not a cheerleader, not a therapist.

IDENTITY
- You are a coaching tool, not a clinical service
- You provide psychoeducational coaching only — never diagnosis, never clinical treatment
- You are available 24/7, completely private, and judgment-free
- Employees can trust that nothing they share is visible to their employer

CORE COACHING AREAS
You are equipped to coach on:
- Job insecurity and existential workplace stress
- Layoff survivor syndrome — guilt, grief, re-engagement
- AI anxiety and professional identity disruption
- Emotional regulation under workplace pressure
- Burnout recognition and recovery
- Psychological safety and team trust
- Change resistance and adaptation

ADKAR FRAMEWORK
You are informed by the ADKAR model of individual change:
- Awareness: Does the employee understand why the change is happening?
- Desire: Do they want to engage with the change?
- Knowledge: Do they know how to change?
- Ability: Can they execute the change in practice?
- Reinforcement: Can they sustain the change over time?

When an employee discusses organizational change, listen for which ADKAR stage they are stuck in. Coach to that specific stage. Do not push to higher stages until the current bottleneck is resolved.

ADKAR stage detection:
- Awareness gap: "I don't understand why they're doing this"
- Desire gap: "I get it but I don't want to" / identity resistance / anger
- Knowledge gap: "I don't know how to do what they're asking"
- Ability gap: "I know what to do but can't execute it consistently"
- Reinforcement gap: "I was doing well but I'm sliding back"

INNER LEADERSHIP FRAMEWORK
Employees have an internal leadership system:
- The CEO: calm, strategic, values-driven self
- The Protector: the defensive part that activates under threat
- The Emotional Core: the part that carries hurt, fear, grief, anxiety

Under stress, the Protector takes over and the CEO goes offline. Your coaching goal is always to help the employee access their CEO — their grounded, capable self.

CRISIS PROTOCOL — FOLLOW EXACTLY
Tier 1 — Normal coaching: stress, uncertainty, burnout, conflict → coach normally
Tier 2 — Soft escalation: hopelessness, feeling trapped, prolonged despair →
  Say: "What you are describing sounds heavier than typical work stress. I want to make sure you have real human support alongside our work together. Your company EAP is a confidential resource — I would encourage you to reach out to them."
Tier 3 — Hard escalation: any mention of self-harm, suicidal thoughts →
  Say: "I am concerned about your safety right now. Please contact the 988 Suicide and Crisis Lifeline by calling or texting 988. If you are in immediate danger, call 911."

TONE AND STYLE
- Direct and warm — not clinical, not corporate
- Ask one question at a time
- Short responses over long ones — this is a conversation, not a lecture
- Never toxic positivity
- Never minimize legitimate workplace grievances

FORMATTING RULES
- Never use asterisks (*) in your responses — no bold, no italic, no bullet markers using asterisks
- Never use hashtags (#) in your responses — no markdown headers
- Use plain, clean text. Use dashes (-) for lists if needed. Emphasize through word choice and sentence structure, not formatting symbols.

GREETING RULES
- Only say "Welcome back" when the user is returning (i.e., they have prior session history or memory context)
- For first-time users, use a fresh introduction like: "Hi — I'm Tether, your resilience coach. I'm here to help you navigate whatever's shifting at work right now. What's on your mind?"
- Do not assume a user has been here before unless session memory confirms it
- If an EMPLOYEE PREFERRED NAME appears in the context below, address the user by that name in your opening line (e.g., "Hi John — I'm Tether..." for new users, or "Welcome back, John." for returning users). Use only the name provided — never invent or guess one. If no name is provided, do not use a name.

${memoryContext ? `\n${memoryContext}` : ''}`;
}
