// =============================================
// TETHER — COACH MODULE
// =============================================

const WORKER_URL = 'https://tether-proxy.john-834.workers.dev';

let conversationHistory = [];
let currentMemoryContext = '';

async function initSession(userId) {
  conversationHistory = [];
  currentMemoryContext = await getMemoryContext(userId);
}

async function sendMessage(userMessage) {
  conversationHistory.push({
    role: 'user',
    content: userMessage
  });

  try {
    const res = await fetch(`${WORKER_URL}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: conversationHistory,
        memoryContext: currentMemoryContext
      })
    });

    const data = await res.json();
    const assistantMessage = data.content[0].text;

    conversationHistory.push({
      role: 'assistant',
      content: assistantMessage
    });

    return assistantMessage;

  } catch (err) {
    console.error('Chat error:', err);
    return "I'm having trouble connecting right now. Please try again in a moment.";
  }
}

async function endSession(userId) {
  if (conversationHistory.length > 0) {
    await saveSessionSummary(userId, conversationHistory);
  }
  conversationHistory = [];
  currentMemoryContext = '';
}

function getMessageCount() {
  return conversationHistory.length;
}
