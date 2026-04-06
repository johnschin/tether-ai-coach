const WORKER_URL = 'https://tether-proxy.john-834.workers.dev';

async function getMemoryContext(userId) {
  try {
    const res = await fetch(`${WORKER_URL}/get-memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId })
    });
    const data = await res.json();
    return data.memoryContext || '';
  } catch (err) {
    console.error('Memory fetch error:', err);
    return '';
  }
}
async function saveSessionSummary(userId, conversation) {
  try {
    const conversationText = conversation.map(m => `${m.role}: ${m.content}`).join('\n');
    await fetch(`${WORKER_URL}/save-summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, conversation: conversationText })
    });
  } catch (err) {
    console.error('Summary save error:', err);
  }
}
async function saveAdkarScores(userId, scores, changeContext) {
  try {
    const res = await fetch(`${WORKER_URL}/adkar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, scores, changeContext })
    });
    const data = await res.json();
    return data.lowestStage;
  } catch (err) {
    console.error('ADKAR save error:', err);
  }
}
