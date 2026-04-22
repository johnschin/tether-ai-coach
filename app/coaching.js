// ─── Tether AI Coach — Coaching Module (Phase E: Pilot 403 handling) ─────────
// Destination in repo: tether-ai-coach/app/coaching.js
//
// Changes from live baseline (coaching.js as of 2026-04-22):
//
//   Phase E — 403 pilot access responses (2026-04-22):
//   The worker now returns HTTP 403 with a JSON body containing { error, message }
//   when a user's company pilot is inactive, not yet started, or has concluded.
//   Previously any non-401 error fell through to the generic "I'm having trouble
//   connecting" message. Now the worker's message is surfaced directly to the
//   user so they understand why access is unavailable and what to do next.
//
//   Error codes returned by the worker:
//     pilot_inactive    — company.active = false
//     pilot_not_started — pilot_start is in the future
//     pilot_concluded   — pilot_end is in the past

let conversationHistory = [];

// ─── Send Message ────────────────────────────────────────────────────────────
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
      if (res.status === 401) {
        return "Your session has expired. Please sign out and sign back in to continue.";
      }

      // 403 = company pilot access denied (pilot_inactive, pilot_not_started,
      // or pilot_concluded). Surface the worker's human-readable message so
      // the user knows what happened and who to contact.
      if (res.status === 403) {
        try {
          const errData = JSON.parse(errText);
          if (errData.message) return errData.message;
        } catch (_) {
          // errText wasn't JSON — fall through to the generic 403 copy below
        }
        return "Access to Tether is not available at this time. Please contact your HR or L&D team for more information.";
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
