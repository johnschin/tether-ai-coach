// ─── Tether AI Coach — Coaching Module ──────────────────────────────────────
// Handles chat messaging with the Cloudflare Worker /chat endpoint.

let conversationHistory = [];

// ─── Send Message ────────────────────────────────────────────────────────────
// Sends user message + full conversation history to Worker, returns assistant reply.
async function sendMessage(userMessage) {
  conversationHistory.push({ role: 'user', content: userMessage });

  try {
    const res = await fetch(`${WORKER_URL}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: conversationHistory,
        memoryContext: memoryContext || ''
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('Chat request failed:', res.status, errText);
      conversationHistory.pop(); // Remove the user message that failed
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
    console.error('Send message error:', e.message);
    conversationHistory.pop();
    return "I'm having trouble connecting right now. Please try again in a moment.";
  }
}
