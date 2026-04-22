// ─── Tether AI Coach — Cloudflare Worker (Phase E: Company-Gated Access) ─────
// Destination in repo: tether-ai-coach/worker/index.js
//
// Changes from live baseline (worker_index_live_2026-04-22.js):
//
//   Phase E — Company-gated endpoint access (2026-04-22):
//   After JWT verification passes, all four application endpoints now check
//   whether the user's company pilot window is currently open. Access is
//   denied with 403 + a human-readable message if:
//     - company.active = false  (company manually deactivated by admin)
//     - pilot_start is in the future  (program not yet open)
//     - pilot_end is in the past  (program concluded)
//   Users with no company_id (admins, unassigned accounts) always pass through.
//
//   Fail-open policy: if either Supabase fetch inside checkPilotAccess fails
//   (network timeout, transient error), the request is allowed through rather
//   than hard-blocking users on infrastructure issues.
//
//   No new env vars required. Reads from existing companies + user_profiles
//   tables via SUPABASE_SERVICE_KEY (already in use by the other handlers).
//
// Deploy: cd worker && npm run deploy  (or: wrangler deploy)

import { createRemoteJWKSet, jwtVerify } from 'jose';

const CORS_HEADERS = {
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// ─── JWKS cache ─────────────────────────────────────────────────────────────
let _jwks = null;
function getJWKS(supabaseUrl) {
  if (!_jwks) {
    _jwks = createRemoteJWKSet(
      new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`)
    );
  }
  return _jwks;
}

// ─── Gate 1: JWT verification ────────────────────────────────────────────────
// Returns { userId, email, claims } on success, { error, status } on failure.
async function verifyAuth(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { error: 'Missing Authorization header', status: 401 };
  }
  const token = authHeader.slice(7).trim();
  if (!token) {
    return { error: 'Empty bearer token', status: 401 };
  }
  if (!env.SUPABASE_URL) {
    console.error('[auth] SUPABASE_URL is not configured');
    return { error: 'Server not configured for authentication', status: 500 };
  }
  try {
    const JWKS = getJWKS(env.SUPABASE_URL);
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
    console.warn('[auth] JWT verification failed:', e.code || e.name || e.message);
    return { error: 'Invalid or expired token', status: 401 };
  }
}

// ─── Gate 2: Company pilot window ────────────────────────────────────────────
// Returns null (access granted) or { error, status, message } (access denied).
//
// Access rules (evaluated in order):
//   1. No company_id on user_profiles → allow (admins, unassigned users)
//   2. company.active = false → 403 pilot_inactive
//   3. pilot_start in the future → 403 pilot_not_started
//   4. pilot_end in the past → 403 pilot_concluded
//   5. All checks pass → allow
//
// Fail-open: any Supabase fetch failure (non-200, network error, parse error)
// lets the request through. We prefer a coaching session for a post-pilot user
// over locking out a valid user due to a transient DB hiccup.
async function checkPilotAccess(userId, env) {
  try {
    // Step 1: get the user's company_id from user_profiles
    const profileRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/user_profiles?id=eq.${userId}&select=company_id`,
      {
        headers: {
          'apikey': env.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`
        }
      }
    );
    if (!profileRes.ok) {
      console.warn('[pilot] profile fetch failed (%d), allowing through', profileRes.status);
      return null;
    }
    const profiles = await profileRes.json();
    const companyId = profiles[0]?.company_id;

    // Admins and unassigned users (company_id = null) always pass through.
    if (!companyId) return null;

    // Step 2: fetch the company's pilot window
    const companyRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/companies?id=eq.${companyId}&select=active,pilot_start,pilot_end`,
      {
        headers: {
          'apikey': env.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`
        }
      }
    );
    if (!companyRes.ok) {
      console.warn('[pilot] company fetch failed (%d), allowing through', companyRes.status);
      return null;
    }
    const companies = await companyRes.json();
    const company = companies[0];

    // No company row found — shouldn't happen, allow through rather than block.
    if (!company) return null;

    // Step 3: evaluate access rules
    if (company.active === false) {
      return {
        error: 'pilot_inactive',
        status: 403,
        message: "Your organization's access to Tether is not currently active. Please contact your HR or L&D team for more information."
      };
    }

    const now = new Date();

    if (company.pilot_start && new Date(company.pilot_start) > now) {
      return {
        error: 'pilot_not_started',
        status: 403,
        message: "Your organization's Tether pilot hasn't begun yet. Please check back on your program start date."
      };
    }

    if (company.pilot_end && new Date(company.pilot_end) < now) {
      return {
        error: 'pilot_concluded',
        status: 403,
        message: "Your organization's Tether pilot has concluded. Thank you for participating. Please reach out to your HR or L&D team if you have questions about continued access."
      };
    }

    return null; // All checks pass — access granted

  } catch (err) {
    // Unexpected error (network timeout, JSON parse failure, etc.)
    // Fail open so infrastructure hiccups don't lock out users.
    console.error('[pilot] checkPilotAccess threw, allowing through:', err.message);
    return null;
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const corsOrigin = env.TETHER_ALLOWED_ORIGIN || '*';

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

    // Gate 1: valid Supabase session JWT required for all application endpoints.
    const auth = await verifyAuth(request, env);
    if (auth.error) {
      return new Response(
        JSON.stringify({ error: auth.error }),
        { status: auth.status, headers: corsHeader }
      );
    }

    // Gate 2: company pilot window must be currently open.
    // Returns null (allow) or { error, status, message } (deny with 403).
    const pilotCheck = await checkPilotAccess(auth.userId, env);
    if (pilotCheck) {
      return new Response(
        JSON.stringify({ error: pilotCheck.error, message: pilotCheck.message }),
        { status: pilotCheck.status, headers: corsHeader }
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

// ─── /chat ───────────────────────────────────────────────────────────────────
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

// ─── /get-memory ─────────────────────────────────────────────────────────────
async function handleGetMemory(request, env, corsHeader, auth) {
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

// ─── /save-summary ────────────────────────────────────────────────────────────
async function handleSaveSummary(request, env, corsHeader, auth) {
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

// ─── /adkar ──────────────────────────────────────────────────────────────────
async function handleAdkar(request, env, corsHeader, auth) {
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

// ─── Memory context ───────────────────────────────────────────────────────────
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

// ─── System prompt ────────────────────────────────────────────────────────────
function buildSystemPrompt(memoryContext) {
  return `You are Tether, an AI psychological resilience coach for employees in corporate environments. You are warm, direct, and psychologically sophisticated \u2014 not a cheerleader, not a therapist.

IDENTITY
- You are a coaching tool, not a clinical service
- You provide psychoeducational coaching only \u2014 never diagnosis, never clinical treatment
- You are available 24/7, completely private, and judgment-free
- Employees can trust that nothing they share is visible to their employer

CORE COACHING AREAS
You are equipped to coach on:
- Job insecurity and existential workplace stress
- Layoff survivor syndrome \u2014 guilt, grief, re-engagement
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

Under stress, the Protector takes over and the CEO goes offline. Your coaching goal is always to help the employee access their CEO \u2014 their grounded, capable self.

CRISIS PROTOCOL \u2014 FOLLOW EXACTLY
Tier 1 \u2014 Normal coaching: stress, uncertainty, burnout, conflict \u2192 coach normally
Tier 2 \u2014 Soft escalation: hopelessness, feeling trapped, prolonged despair \u2192
  Say: "What you are describing sounds heavier than typical work stress. I want to make sure you have real human support alongside our work together. Your company EAP is a confidential resource \u2014 I would encourage you to reach out to them."
Tier 3 \u2014 Hard escalation: any mention of self-harm, suicidal thoughts \u2192
  Say: "I am concerned about your safety right now. Please contact the 988 Suicide and Crisis Lifeline by calling or texting 988. If you are in immediate danger, call 911."

TONE AND STYLE
- Direct and warm \u2014 not clinical, not corporate
- Ask one question at a time
- Short responses over long ones \u2014 this is a conversation, not a lecture
- Never toxic positivity
- Never minimize legitimate workplace grievances

FORMATTING RULES
- Never use asterisks (*) in your responses \u2014 no bold, no italic, no bullet markers using asterisks
- Never use hashtags (#) in your responses \u2014 no markdown headers
- Use plain, clean text. Use dashes (-) for lists if needed. Emphasize through word choice and sentence structure, not formatting symbols.

GREETING RULES
- Only say "Welcome back" when the user is returning (i.e., they have prior session history or memory context)
- For first-time users, use a fresh introduction like: "Hi \u2014 I'm Tether, your resilience coach. I'm here to help you navigate whatever's shifting at work right now. What's on your mind?"
- Do not assume a user has been here before unless session memory confirms it
- If an EMPLOYEE PREFERRED NAME appears in the context below, address the user by that name in your opening line (e.g., "Hi John \u2014 I'm Tether..." for new users, or "Welcome back, John." for returning users). Use only the name provided \u2014 never invent or guess one. If no name is provided, do not use a name.

${memoryContext ? `\n${memoryContext}` : ''}`;
}
