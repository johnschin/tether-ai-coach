// ─── Tether AI Coach — Memory Module (HARDENED v2) ─────────────────────────
// Destination in repo: tether-ai-coach/app/memory.js
//
// Changes from prior version (JWT hardening, Phase 1):
//   1. Every worker call now sends the user's current Supabase access token
//      in the Authorization header (`Bearer <token>`).
//   2. `getAuthHeaders()` helper pulls the token fresh from supabase-js, which
//      auto-refreshes a near-expiry token under the hood — so we don't worry
//      about token lifetime management at the call site.
//   3. If there's no active session, `getAuthHeaders()` throws. Callers catch
//      it and log; the UI stays functional but the worker call is skipped.
//
// NOTE on script ordering (unchanged from before):
//   index.html loads scripts in this order: auth.js → memory.js → coaching.js
//   That means `supabaseClient` (created in auth.js) is already available here,
//   and `getAuthHeaders()` below is available to coaching.js.

const WORKER_URL = 'https://tether-proxy.john-834.workers.dev';
let memoryContext = '';
let sessionStartTime = null;

// ─── Auth header helper ─────────────────────────────────────────────────────
// Returns headers ready to spread into a fetch() call. Throws if there is no
// active session — in that case, the caller should NOT retry; the user needs
// to re-authenticate. supabase-js v2 auto-refreshes the access token on
// getSession() if it's near expiry, so we get a fresh token on every call.
async function getAuthHeaders() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session?.access_token) {
    throw new Error('No active Supabase session — cannot call worker');
  }
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${session.access_token}`
  };
}

// ─── Initialize Session ─────────────────────────────────────────────────────
// Called when user enters the app. Fetches prior session memory from worker.
async function initSession(userId) {
  sessionStartTime = new Date();
  memoryContext = '';
  try {
    const headers = await getAuthHeaders();
    const res = await fetch(`${WORKER_URL}/get-memory`, {
      method: 'POST',
      headers,
      // userId is no longer strictly needed (worker reads it from the JWT),
      // but keeping it in the body is harmless and eases staged rollout: if
      // the hardened worker is live before this frontend deploys, the older
      // frontend still works; if the new frontend ships before the hardened
      // worker, the worker just ignores the now-unused body field.
      body: JSON.stringify({ userId })
    });
    if (!res.ok) {
      console.error('Memory fetch failed:', res.status);
      return;
    }
    const data = await res.json();
    if (data.memoryContext) {
      memoryContext = data.memoryContext;
    }
  } catch (e) {
    console.error('Failed to initialize session memory:', e.message);
  }
}

// ─── Save ADKAR Scores ─────────────────────────────────────────────────────
async function saveAdkarScores(userId, scores, changeContext) {
  try {
    const headers = await getAuthHeaders();
    const res = await fetch(`${WORKER_URL}/adkar`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userId, scores, changeContext })
    });
    if (!res.ok) {
      console.error('ADKAR save failed:', res.status);
    }
  } catch (e) {
    console.error('Failed to save ADKAR scores:', e.message);
  }
}

// ─── End Session ────────────────────────────────────────────────────────────
// Sends conversation to worker for AI summarization and storage.
async function endSession(userId) {
  if (typeof conversationHistory === 'undefined' || conversationHistory.length === 0) {
    return;
  }
  const conversation = conversationHistory
    .map(m => `${m.role === 'user' ? 'Employee' : 'Coach'}: ${m.content}`)
    .join('\n\n');
  try {
    const headers = await getAuthHeaders();
    const res = await fetch(`${WORKER_URL}/save-summary`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userId, conversation })
    });
    if (!res.ok) {
      console.error('Session summary save failed:', res.status);
    }
  } catch (e) {
    console.error('Failed to save session summary:', e.message);
  }
  // Reset conversation for next session
  conversationHistory = [];
}
