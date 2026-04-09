// ─── Tether AI Coach — Memory Module ────────────────────────────────────────
// Handles session initialization, memory retrieval, and session summary saving.
// Communicates with Cloudflare Worker endpoints.

const WORKER_URL = 'https://tether-proxy.john-834.workers.dev';

let memoryContext = '';
let sessionStartTime = null;

// ─── Initialize Session ──────────────────────────────────────────────────────
// Called when user enters the app. Fetches prior session memory from worker.
async function initSession(userId) {
  sessionStartTime = new Date();
  memoryContext = '';

  try {
    const res = await fetch(`${WORKER_URL}/get-memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

// ─── Save ADKAR Scores ──────────────────────────────────────────────────────
async function saveAdkarScores(userId, scores, changeContext) {
  try {
    const res = await fetch(`${WORKER_URL}/adkar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, scores, changeContext })
    });

    if (!res.ok) {
      console.error('ADKAR save failed:', res.status);
    }
  } catch (e) {
    console.error('Failed to save ADKAR scores:', e.message);
  }
}

// ─── End Session ─────────────────────────────────────────────────────────────
// Sends conversation to worker for AI summarization and storage.
async function endSession(userId) {
  if (typeof conversationHistory === 'undefined' || conversationHistory.length === 0) {
    return;
  }

  const conversation = conversationHistory
    .map(m => `${m.role === 'user' ? 'Employee' : 'Coach'}: ${m.content}`)
    .join('\n\n');

  try {
    const res = await fetch(`${WORKER_URL}/save-summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
