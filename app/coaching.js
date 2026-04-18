// ─── Tether AI Coach — Coaching Module (HARDENED v2) ───────────────────────
// Destination in repo: tether-ai-coach/app/coaching.js
//
// Changes from prior version (JWT hardening, Phase 1):
//   1. /chat calls now include the user's Supabase access token in the
//      Authorization header, via `getAuthHeaders()` (defined in memory.js).
//   2. 401 responses are handled distinctly — the user's session expired or
//      is invalid, and they should be told to sign back in rather than
//      retrying silently.

let conversationHistory = [];

// ─── Send Message ───────────────────────────────────────────────────────────
// Sends user message + full conversation history to Worker, returns assistant reply.
async function sendMessage(userMessage) {
  conversationHistory.push({ role: 'user', content: userMessage });
  try {
    const headers = await getAuthHeaders();
    const res = await fetch(`${WORKER_URL}/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages: conversationHistory,
        memoryContext: memoryContext || ''
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error('Chat request failed:', res.status, errText);
      conversationHistory.pop(); // Remove the user message that failed

      // 401 = session expired or token rejected by worker.
      // Don't retry silently — tell the user to re-auth.
      if (res.status === 401) {
        return "Your session has expired. Please sign out and sign back in to continue.";
      }
      return "I'm having trouble connecting right now. Please try again in a moment.";
    }
    const data = await res.json();
    // Handle error responses from the worker
    if (data.error) {
      console.error('Worker returned error:', data.error);
      conversationHistory.pop();
      return "I'm having trouble connecting right now. Please try again in a moment.";
    }
    // Extract assistant message from Claude API response format
    let assistantMessage = '';
    if (data.content && data.content[0] && data.content[0].text) {
      // Direct Claude API response format (from index.js worker)
      assistantMessage = data.content[0].text;
    } else if (data.response) {
      // Wrapped response format (from worker.js RAG worker)
      assistantMessage = data.response;
    } else {
      console.error('Unexpected response format:', JSON.stringify(data).slice(0, 500));
      conversationHistory.pop();
      return "I received an unexpected response. Please try again.";
    }
    conversationHistory.push({ role: 'assistant', content: assistantMessage });
    return assistantMessage;
  } catch (e) {
    // `getAuthHeaders()` throws when there's no active session. That almost
    // certainly means the auth state was lost between page load and send.
    console.error('Send message error:', e.message);
    conversationHistory.pop();
    if (e.message && e.message.includes('No active Supabase session')) {
      return "Your session was lost. Please sign out and sign back in.";
    }
    return "I'm having trouble connecting right now. Please try again in a moment.";
  }
}
