// =============================================
// TETHER AI COACH — CLOUDFLARE WORKER
// Evolved Caveman AI, LLC
// =============================================

const CORS_HEADERS = {
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export default {
  async fetch(request, env) {

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          ...CORS_HEADERS,
          'Access-Control-Allow-Origin': env.TETHER_ALLOWED_ORIGIN,
        }
      });
    }

    const corsHeader = {
      'Access-Control-Allow-Origin': env.TETHER_ALLOWED_ORIGIN,
      'Content-Type': 'application/json',
    };

    const { pathname } = new URL(request.url);

    try {
      if (pathname === '/chat')         return handleChat(request, env, corsHeader);
      if (pathname === '/get-memory')   return handleGetMemory(request, env, corsHeader);
      if (pathname === '/save-summary') return handleSaveSummary(request, env, corsHeader);
      if (pathname === '/adkar')        return handleAdkar(request, env, corsHeader);

      return new Response(
        JSON.stringify({ error: 'Not found' }),
        { status: 404, headers: corsHeader }
      );

    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 500, headers: corsHeader }
      );
    }
  }
};

// =============================================
// CHAT HANDLER
// =============================================
async function handleChat(request, env, corsHeader) {
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
      messages: messages
    })
  });

  const data = await response.json();
  return new Response(JSON.stringify(data), { headers: corsHeader });
}

// =============================================
// GET MEMORY HANDLER
// =============================================
async function handleGetMemory(request, env, corsHeader) {
  const { userId } = await request.json();

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

  const memoryContext = buildMemoryContext(summaries, profile[0], adkar[0]);

  return new Response(
    JSON.stringify({ memoryContext }),
    { headers: corsHeader }
  );
}

// =============================================
// SAVE SUMMARY HANDLER
// =============================================
async function handleSaveSummary(request, env, corsHeader) {
  const { userId, conversation } = await request.json();

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
  } catch(e) {
    parsed = {
      summary: "Session completed",
      themes: [],
      tools_used: [],
      emotional_tone: "neutral"
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

// =============================================
// ADKAR HANDLER
// =============================================
async function handleAdkar(request, env, corsHeader) {
  const { userId, scores, changeContext } = await request.json();

  const stages = ['awareness','desire','knowledge','ability','reinforcement'];
  let lowestStage = stages[0];
  let lowestScore = scores.awareness;

  stages.forEach(stage => {
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

// =============================================
// MEMORY CONTEXT BUILDER
// =============================================
function buildMemoryContext(summaries, profile, adkar) {
  if (!summaries?.length && !profile && !adkar) return '';

  let context = 'COACHING HISTORY FOR THIS EMPLOYEE:\n\n';

  if (summaries?.length) {
    context += 'Recent sessions:\n';
    summaries.forEach(s => {
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

  context += `Use this history to provide continuity. Reference prior sessions naturally when relevant. Do not recite this history back verbatim.`;

  return context;
}

// =============================================
// SYSTEM PROMPT BUILDER
// =============================================
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

${memoryContext ? `\n${memoryContext}` : ''}`;
}
