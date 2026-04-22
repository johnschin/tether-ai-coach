// ─── Tether AI Coach — Coaching Module (Phase F: Free Trial) ─────────────────
// Destination in repo: tether-ai-coach/app/coaching.js
//
// Changes from Phase E (phase_e_coaching.js):
//
//   Phase F — Free trial prompt tracking + trial-expired handling (2026-04-22):
//
//   1. latestTrialStatus (module-level):
//      Stores the most recent { prompts_used, prompts_remaining, started_at }
//      returned by the worker on successful chat responses. Read by app.js via
//      getTrialStatus() to update the trial status bar in the chat header.
//
//   2. sessionPromptCount (module-level):
//      Counts prompts sent in the current coaching session (ADKAR → chat cycle).
//      Resets to 0 when resetSessionPromptCount() is called from app.js at the
//      start of each new session. At SESSION_PROMPT_LIMIT (20), showSessionLimitBanner()
//      is called in app.js to suggest the user end the session and start fresh.
//
//   3. Trial-expired 403 handling:
//      When the worker returns HTTP 403 with { error: 'trial_expired' }, instead
//      of surfacing a chat-style error message, sendMessage() calls
//      handleTrialExpired(reason) (defined in app.js) and returns an empty string
//      so the caller adds nothing to the message list.
//
//   4. Last-prompt detection:
//      When a successful response includes trial_status.prompts_remaining === 0,
//      showTrialEndedScreen('prompts_exhausted') is called (from app.js) after a
//      1.5s delay — enough time for the user to read the final coach message
//      before the screen transitions.

const SESSION_PROMPT_LIMIT = 20;

// ─── Module-level trial state ─────────────────────────────────────────────────
// latestTrialStatus: updated after every successful /chat response.
// Null until the first successful chat or when user is a company pilot member.
let latestTrialStatus = null;

// sessionPromptCount: increments per send, resets at new session start.
let sessionPromptCount = 0;

// ─── Public accessors used by app.js ─────────────────────────────────────────
function getTrialStatus()           { return latestTrialStatus; }
function resetSessionPromptCount()  { sessionPromptCount = 0; }

// ─── Conversation history ─────────────────────────────────────────────────────
let conversationHistory = [];

// ─── Send Message ─────────────────────────────────────────────────────────────
// Sends user message + full conversation history to Worker, returns assistant
// reply (string). Returns '' (empty) if the trial is expired — caller should
// not add an empty message to the UI; app.js handles the screen transition.
async function sendMessage(userMessage) {
  conversationHistory.push({ role: 'user', content: userMessage });
  sessionPromptCount += 1;

  try {
    const headers = await getAuthHeaders();
    const res = await fetch(`${WORKER_URL}/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages:      conversationHistory,
        memoryContext: memoryContext || ''
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('Chat request failed:', res.status, errText);
      conversationHistory.pop();

      // 401 — session expired
      if (res.status === 401) {
        sessionPromptCount = Math.max(0, sessionPromptCount - 1);
        return "Your session has expired. Please sign out and sign back in to continue.";
      }

      // 403 — could be pilot access denied OR trial expired
      if (res.status === 403) {
        try {
          const errData = JSON.parse(errText);

          // Phase F: trial expired — transition to the trial-ended screen.
          // Do NOT decrement sessionPromptCount here: the prompt was sent to the
          // server and rejected because the trial was already exhausted, so the
          // count should stay at its current value (at or past SESSION_PROMPT_LIMIT).
          if (errData.error === 'trial_expired') {
            // Call app.js handler after microtask to ensure the user message
            // is rendered first (addMessage was already called in handleSend)
            setTimeout(() => {
              if (typeof handleTrialExpired === 'function') {
                handleTrialExpired(errData.reason || 'unknown');
              }
            }, 0);
            return ''; // sentinel — handleSend checks for empty string and skips addMessage
          }

          // Phase E: pilot access denied — surface the worker's human-readable message
          if (errData.message) {
            sessionPromptCount = Math.max(0, sessionPromptCount - 1);
            return errData.message;
          }
        } catch (_) {
          // errText wasn't JSON — fall through
        }
        sessionPromptCount = Math.max(0, sessionPromptCount - 1);
        return "Access to Tether is not available at this time. Please contact your HR or L&D team for more information.";
      }

      sessionPromptCount = Math.max(0, sessionPromptCount - 1);
      return "I'm having trouble connecting right now. Please try again in a moment.";
    }

    const data = await res.json();

    // Handle error responses from the worker
    if (data.error) {
      console.error('Worker returned error:', data.error);
      conversationHistory.pop();
      sessionPromptCount = Math.max(0, sessionPromptCount - 1);
      return "I'm having trouble connecting right now. Please try again in a moment.";
    }

    // Extract assistant message from Claude API response format
    let assistantMessage = '';
    if (data.content && data.content[0] && data.content[0].text) {
      assistantMessage = data.content[0].text;
    } else if (data.response) {
      assistantMessage = data.response;
    } else {
      console.error('Unexpected response format:', JSON.stringify(data).slice(0, 500));
      conversationHistory.pop();
      sessionPromptCount = Math.max(0, sessionPromptCount - 1);
      return "I received an unexpected response. Please try again.";
    }

    conversationHistory.push({ role: 'assistant', content: assistantMessage });

    // ── Phase F: process trial_status from worker ─────────────────────────────
    if (data.trial_status) {
      latestTrialStatus = data.trial_status;

      // Update the trial status bar in the chat header
      if (typeof updateTrialStatusBar === 'function') {
        updateTrialStatusBar(latestTrialStatus);
      }

      // If this was the last allowed prompt, queue the trial-ended screen
      // after a short delay so the user can read the final message first.
      if (latestTrialStatus.prompts_remaining === 0) {
        setTimeout(() => {
          if (typeof showTrialEndedScreen === 'function') {
            showTrialEndedScreen('prompts_exhausted');
          }
        }, 1500);
      }
    }

    // ── Per-session prompt limit soft nudge ───────────────────────────────────
    // At SESSION_PROMPT_LIMIT, suggest the user end this session and start a
    // fresh one to keep conversations focused. This is advisory — not a block.
    if (sessionPromptCount >= SESSION_PROMPT_LIMIT) {
      setTimeout(() => {
        if (typeof showSessionLimitBanner === 'function') {
          showSessionLimitBanner();
        }
      }, 800);
    }

    return assistantMessage;

  } catch (e) {
    // getAuthHeaders() throws when there's no active session
    console.error('Send message error:', e.message);
    conversationHistory.pop();
    sessionPromptCount = Math.max(0, sessionPromptCount - 1);
    if (e.message && e.message.includes('No active Supabase session')) {
      return "Your session was lost. Please sign out and sign back in.";
    }
    return "I'm having trouble connecting right now. Please try again in a moment.";
  }
}
