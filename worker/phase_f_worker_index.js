// ─── Tether AI Coach — Cloudflare Worker (Phase F: Free Trial Gate) ──────────
// Destination in repo: tether-ai-coach/worker/index.js
//
// Changes from Phase E (phase_e_worker_index.js):
//
//   Phase F — Free trial enforcement on /chat (2026-04-22):
//
//   Users with no company_id get a free trial capped at:
//     - 60 total prompts  (TRIAL_MAX_PROMPTS)
//     - 14 days from first prompt  (TRIAL_DAYS)
//   These limits are enforced server-side in checkTrialAccess(), which runs
//   inside handleChat() after JWT + pilot-window checks pass.
//
//   Trial state is stored on user_profiles:
//     - trial_started_at: set on the very first prompt; NULL until then
//     - trial_prompt_count: incremented atomically on each successful chat
//
//   Trial expiry returns HTTP 403 with:
//     { error: 'trial_expired', reason: 'prompts_exhausted'|'time_limit', message: '...' }
//   coaching.js catches this and calls showTrialEndedScreen(reason) in app.js.
//
//   Successful chat responses for trial users include:
//     { ...claudeApiResponse, trial_status: { prompts_used, prompts_remaining, started_at } }
//   coaching.js uses this to update the trial status bar in the chat header.
//
//   Users WITH a company_id skip all trial checks entirely — they access Tether
//   through their company's pilot (gated by checkPilotAccess from Phase E).
//
//   Fail-open policy for trial checks: if the Supabase profile fetch fails
//   (network timeout, transient error), the request is allowed through so
//   infrastructure issues don't lock out users. The trial count update is
//   fire-and-forget (does not delay the response).
//
// Deploy: cd worker && npm run deploy  (or: wrangler deploy)

import { createRemoteJWKSet, jwtVerify } from 'jose';

const TRIAL_MAX_PROMPTS = 60;
const TRIAL_DAYS        = 14;

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

// ─── Gate 2: Company pilot window (Phase E, unchanged) ───────────────────────
// Returns null (access granted) or { error, status, message } (access denied).
//
// Users with no company_id (free trial users, admins) always pass through here.
// Their access is governed by checkTrialAccess() inside handleChat() instead.
async function checkPilotAccess(userId, env) {
  try {
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

    // No company → pass through (free trial users are handled by checkTrialAccess)
    if (!companyId) return null;

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
    if (!company) return null;

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
    return null;

  } catch (err) {
    console.error('[pilot] checkPilotAccess threw, allowing through:', err.message);
    return null;
  }
}

// ─── Gate 3: Free trial access (Phase F, /chat only) ─────────────────────────
// Called inside handleChat() for every request that passed Gates 1 + 2.
//
// Returns one of:
//   { isTrial: false }
//     → user has company_id, skip trial checks entirely
//   { isTrial: true, deny: null, profile }
//     → trial user, within limits, safe to proceed; profile is the raw DB row
//   { isTrial: true, deny: { error, status, message } }
//     → trial expired; return this as a 403 immediately
//
// Fail-open: any Supabase error returns { isTrial: false } (allows through)
// to avoid locking users out during infrastructure hiccups.
async function checkTrialAccess(userId, env) {
  try {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/user_profiles?id=eq.${userId}` +
      `&select=company_id,trial_started_at,trial_prompt_count`,
      {
        headers: {
          'apikey': env.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`
        }
      }
    );
    if (!res.ok) {
      console.warn('[trial] profile fetch failed (%d), allowing through', res.status);
      return { isTrial: false };
    }
    const rows = await res.json();
    const profile = rows[0];

    // Has company_id → company pilot user, no trial limits
    if (profile?.company_id) return { isTrial: false };

    const promptsUsed = profile?.trial_prompt_count || 0;
    const startedAt   = profile?.trial_started_at   || null;

    // ── Time limit check ──────────────────────────────────────────────────────
    if (startedAt) {
      const expiryMs = new Date(startedAt).getTime() + TRIAL_DAYS * 86_400_000;
      if (Date.now() > expiryMs) {
        return {
          isTrial: true,
          deny: {
            error:   'trial_expired',
            reason:  'time_limit',
            status:  403,
            message: `Your ${TRIAL_DAYS}-day free trial has ended. Register your interest below to be considered for an organizational pilot.`
          }
        };
      }
    }

    // ── Prompt limit check ────────────────────────────────────────────────────
    if (promptsUsed >= TRIAL_MAX_PROMPTS) {
      return {
        isTrial: true,
        deny: {
          error:   'trial_expired',
          reason:  'prompts_exhausted',
          status:  403,
          message: `You've used all ${TRIAL_MAX_PROMPTS} prompts in your free trial. Register your interest below to be considered for an organizational pilot.`
        }
      };
    }

    return { isTrial: true, deny: null, profile };

  } catch (err) {
    console.error('[trial] checkTrialAccess threw, allowing through:', err.message);
    return { isTrial: false };
  }
}

// ─── Trial count update ───────────────────────────────────────────────────────
// Two functions:
//   computeTrialStatus(profile) — synchronous; builds the status object to
//     embed in the response. Returns internal fields (isFirst, newCount) plus
//     the public {prompts_used, prompts_remaining, started_at} payload.
//   persistTrialCounts(userId, ts, env) — async; PATCHes user_profiles. Must be
//     passed to ctx.waitUntil() so Cloudflare doesn't kill the request before
//     the DB write completes (fire-and-forget inside a Worker only works when
//     registered with waitUntil — otherwise it's cancelled on response flush).
//
// Called ONLY after a confirmed successful Anthropic API response so failed
// or overloaded API calls don't consume trial quota.

function computeTrialStatus(profile) {
  const newCount  = (profile?.trial_prompt_count || 0) + 1;
  const isFirst   = !profile?.trial_started_at;
  const startedAt = isFirst ? new Date().toISOString() : profile.trial_started_at;
  return {
    // Public fields — returned to the client inside trial_status
    prompts_used:      newCount,
    prompts_remaining: Math.max(0, TRIAL_MAX_PROMPTS - newCount),
    started_at:        startedAt,
    // Internal fields — used by persistTrialCounts, stripped before sending
    _newCount:  newCount,
    _isFirst:   isFirst
  };
}

async function persistTrialCounts(userId, ts, env) {
  const updates = { trial_prompt_count: ts._newCount };
  if (ts._isFirst) updates.trial_started_at = ts.started_at;
  try {
    await fetch(
      `${env.SUPABASE_URL}/rest/v1/user_profiles?id=eq.${userId}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type':  'application/json',
          'apikey':        env.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`
        },
        body: JSON.stringify(updates)
      }
    );
  } catch (e) {
    console.warn('[trial] count persist failed:', e.message);
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
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

    // Gate 1: valid Supabase session JWT required for all endpoints
    const auth = await verifyAuth(request, env);
    if (auth.error) {
      return new Response(
        JSON.stringify({ error: auth.error }),
        { status: auth.status, headers: corsHeader }
      );
    }

    // Gate 2: company pilot window must be open (free trial users pass through)
    const pilotCheck = await checkPilotAccess(auth.userId, env);
    if (pilotCheck) {
      return new Response(
        JSON.stringify({ error: pilotCheck.error, message: pilotCheck.message }),
        { status: pilotCheck.status, headers: corsHeader }
      );
    }

    try {
      if (pathname === '/chat')         return handleChat(request, env, corsHeader, auth, ctx);
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
async function handleChat(request, env, corsHeader, auth, ctx) {
  const { messages, memoryContext } = await request.json();

  // Gate 3: free trial limit check (only for users with no company_id)
  const trial = await checkTrialAccess(auth.userId, env);
  if (trial.deny) {
    return new Response(
      JSON.stringify({
        error:   trial.deny.error,
        reason:  trial.deny.reason,
        message: trial.deny.message
      }),
      { status: trial.deny.status, headers: corsHeader }
    );
  }

  const systemPrompt = buildSystemPrompt(memoryContext);

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':       'application/json',
      'x-api-key':          env.ANTHROPIC_API_KEY,
      'anthropic-version':  '2023-06-01'
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system:     systemPrompt,
      messages
    })
  });
  const data = await anthropicRes.json();

  // Only count the prompt + attach trial_status when the Anthropic API
  // actually returned a successful response. Failed API calls (rate-limit,
  // overload, invalid request) must NOT eat trial quota.
  // ctx.waitUntil() ensures the PATCH completes even after the response is
  // flushed — without it, Cloudflare kills unawaited promises on flush.
  if (trial.isTrial && trial.profile && anthropicRes.ok && !data.error) {
    const ts = computeTrialStatus(trial.profile);
    ctx.waitUntil(persistTrialCounts(auth.userId, ts, env));
    // Strip internal fields before sending to client
    const trialStatus = {
      prompts_used:      ts.prompts_used,
      prompts_remaining: ts.prompts_remaining,
      started_at:        ts.started_at
    };
    return new Response(
      JSON.stringify({ ...data, trial_status: trialStatus }),
      { headers: corsHeader }
    );
  }

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
      'Content-Type':       'application/json',
      'x-api-key':          env.ANTHROPIC_API_KEY,
      'anthropic-version':  '2023-06-01'
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-20250514',
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
      summary:        'Session completed',
      themes:         [],
      tools_used:     [],
      emotional_tone: 'neutral'
    };
  }

  await fetch(`${env.SUPABASE_URL}/rest/v1/session_summaries`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`
    },
    body: JSON.stringify({
      user_id:        userId,
      summary:        parsed.summary,
      themes:         parsed.themes,
      tools_used:     parsed.tools_used,
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
      'Content-Type':  'application/json',
      'apikey':        env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`
    },
    body: JSON.stringify({
      user_id:              userId,
      change_context:       changeContext || 'general',
      awareness_score:      scores.awareness,
      desire_score:         scores.desire,
      knowledge_score:      scores.knowledge,
      ability_score:        scores.ability,
      reinforcement_score:  scores.reinforcement,
      lowest_stage:         lowestStage
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
