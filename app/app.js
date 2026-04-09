let currentUser = null;
let adkarScores = {};
let appShown = false;

window.addEventListener('DOMContentLoaded', async () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(console.error);
  }

  // Clean up auth hash from URL (magic link leaves tokens in fragment)
  if (window.location.hash && window.location.hash.includes('access_token')) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  const session = await getSession();
  if (session?.user) {
    enterApp(session.user);
  } else {
    showScreen('auth-screen');
  }

  onAuthStateChange(async (event, session) => {
    if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session?.user) {
      enterApp(session.user);
    }
    if (event === 'SIGNED_OUT') {
      currentUser = null;
      appShown = false;
      showScreen('auth-screen');
    }
  });
});

// ─── Auth Helpers ──────────────────────────────────────────────────
async function enterApp(user) {
  if (appShown) return;
  appShown = true;
  currentUser = user;

  // Save preferred name to user profile if provided during sign-up
  const storedName = localStorage.getItem('tether_preferred_name');
  if (storedName) {
    try {
      await supabaseClient.auth.updateUser({ data: { preferred_name: storedName } });
      await supabaseClient.from('user_profiles').upsert({ id: user.id, preferred_name: storedName }, { onConflict: 'id' });
    } catch (e) { console.error('Could not save preferred name:', e); }
    localStorage.removeItem('tether_preferred_name');
  }

  await startUserSession();
}

function checkCorporateEmail(value) {
  const warning = document.getElementById('corp-email-warning');
  if (!warning) return;
  if (!value || !value.includes('@')) {
    warning.style.display = 'none';
    return;
  }
  warning.style.display = isPersonalEmail(value) ? 'none' : 'block';
}

async function handleMagicLink() {
  const emailInput = document.getElementById('magic-email');
  const nameInput = document.getElementById('magic-name');
  const btn = document.getElementById('magic-btn');
  const errorEl = document.getElementById('auth-error');
  const email = emailInput.value.trim().toLowerCase();
  const preferredName = nameInput.value.trim();

  if (!email || !email.includes('@') || !email.includes('.')) {
    errorEl.textContent = 'Please enter a valid email address.';
    return;
  }

  // Store name locally so we can save it after auth completes
  if (preferredName) {
    localStorage.setItem('tether_preferred_name', preferredName);
  }

  errorEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Sending link...';

  try {
    await sendMagicLink(email);
    // Show check-email state
    document.getElementById('magic-form').style.display = 'none';
    document.getElementById('check-email').style.display = 'block';
    document.getElementById('sent-email-display').textContent = email;
  } catch (err) {
    errorEl.textContent = err.message || 'Something went wrong. Please try again.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send me a login link';
  }
}

function resetMagicForm() {
  document.getElementById('magic-form').style.display = 'block';
  document.getElementById('check-email').style.display = 'none';
  document.getElementById('auth-error').textContent = '';
  const warning = document.getElementById('corp-email-warning');
  if (warning) warning.style.display = 'none';
  document.getElementById('magic-name').value = '';
  document.getElementById('magic-email').value = '';
  document.getElementById('magic-name').focus();
}

async function handleSignOut() {
  if (typeof conversationHistory !== 'undefined' && conversationHistory.length > 0) await endSession(currentUser.id);
  appShown = false;
  await signOut();
}

async function startUserSession() {
  const name = currentUser.user_metadata?.preferred_name || currentUser.email?.split('@')[0];
  if (name) document.getElementById('user-greeting').textContent = `Hi ${name} — your session is private`;
  await initSession(currentUser.id);

  // Check if returning user (has previous sessions) and set welcome message accordingly
  let isReturning = false;
  try {
    const { data } = await supabaseClient
      .from('session_summaries')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', currentUser.id);
    isReturning = data && data.length > 0;
  } catch (e) { console.error('Could not check session history:', e); }

  const welcomeEl = document.querySelector('#messages .welcome-msg');
  if (welcomeEl) {
    if (isReturning) {
      welcomeEl.innerHTML = `<strong>Welcome back.</strong> Whatever brought you here today — you're in the right place. What's on your mind?`;
    } else {
      welcomeEl.innerHTML = `<strong>Hi — I'm Tether, your resilience coach.</strong> I'm here to help you navigate whatever's shifting at work right now, whether that's a reorg, a new role, a process change, or just the general feeling of "everything is different and I'm not sure what to do." What's on your mind?`;
    }
  }

  showScreen('adkar-screen');
}

// ─── ADKAR ─────────────────────────────────────────────────────────
function setScore(stage, score) {
  adkarScores[stage] = score;
  document.querySelectorAll(`#scale-${stage} button`).forEach((btn, i) => {
    btn.classList.toggle('selected', i + 1 === score);
  });
}
async function submitAdkar() {
  const required = ['awareness','desire','knowledge','ability','reinforcement'];
  const missing = required.filter(s => !adkarScores[s]);
  if (missing.length > 0) { document.getElementById(`scale-${missing[0]}`).scrollIntoView({ behavior: 'smooth' }); return; }
  const changeContext = document.getElementById('adkar-context-select').value;
  await saveAdkarScores(currentUser.id, adkarScores, changeContext);
  showScreen('chat-screen');
}
function skipAdkar() { showScreen('chat-screen'); }

// ─── Chat ──────────────────────────────────────────────────────────
async function handleSend() {
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message) return;
  input.value = ''; input.style.height = 'auto';
  document.getElementById('send-btn').disabled = true;
  addMessage('user', message);
  showTyping(true);
  const response = await sendMessage(message);
  showTyping(false);
  addMessage('assistant', response);
  document.getElementById('send-btn').disabled = false;
  input.focus();
}
function handleKeyDown(event) {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); handleSend(); }
}
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}
async function handleEndSession() {
  if (confirm('End this session? Tether will save a summary to remember your progress.')) {
    await endSession(currentUser.id);
    adkarScores = {};
    document.getElementById('messages').innerHTML = `<div class="welcome-msg"><strong>Session saved.</strong> Your progress has been noted. Come back whenever you need.</div>`;
    showScreen('adkar-screen');
  }
}
function addMessage(role, content) {
  const messages = document.getElementById('messages');
  const welcome = messages.querySelector('.welcome-msg');
  if (welcome) welcome.remove();
  const div = document.createElement('div');
  div.className = `message ${role}`;
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  div.innerHTML = `<div class="message-bubble">${content}</div><div class="message-time">${time}</div>`;
  messages.appendChild(div);

  // For user messages, scroll to bottom so they can see their own message fully.
  // For assistant messages, scroll to the TOP of the new bubble so the user
  // reads from the beginning and can scroll down.
  if (role === 'user') {
    messages.scrollTop = messages.scrollHeight;
  } else {
    div.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
function showTyping(visible) {
  document.getElementById('typing').classList.toggle('visible', visible);
  document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
}
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
