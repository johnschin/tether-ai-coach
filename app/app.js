let currentUser = null;
let adkarScores = {};

window.addEventListener('DOMContentLoaded', async () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(console.error);
  }
  const session = await getSession();
  if (session?.user) {
    currentUser = session.user;
    await startUserSession();
  }
  onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN' && session?.user) {
      currentUser = session.user;
      await startUserSession();
    }
    if (event === 'SIGNED_OUT') {
      currentUser = null;
      showScreen('auth-screen');
    }
  });
});

function showTab(tab) {
  document.querySelectorAll('.auth-tab').forEach((t, i) => {
    t.classList.toggle('active', (i === 0 && tab === 'signin') || (i === 1 && tab === 'signup'));
  });
  document.getElementById('signin-form').style.display = tab === 'signin' ? 'block' : 'none';
  document.getElementById('signup-form').style.display = tab === 'signup' ? 'block' : 'none';
  document.getElementById('auth-error').textContent = '';
}
async function handleSignIn() {
  const email = document.getElementById('signin-email').value.trim();
  const password = document.getElementById('signin-password').value;
  const btn = document.querySelector('#signin-form .auth-btn');
  if (!email || !password) { document.getElementById('auth-error').textContent = 'Please enter your email and password.'; return; }
  btn.disabled = true; btn.textContent = 'Signing in...';
  try { await signIn(email, password); }
  catch (err) { document.getElementById('auth-error').textContent = err.message; btn.disabled = false; btn.textContent = 'Sign In'; }
}
async function handleSignUp() {
  const name = document.getElementById('signup-name').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const btn = document.querySelector('#signup-form .auth-btn');
  if (!email || !password) { document.getElementById('auth-error').textContent = 'Email and password are required.'; return; }
  if (password.length < 8) { document.getElementById('auth-error').textContent = 'Password must be at least 8 characters.'; return; }
  btn.disabled = true; btn.textContent = 'Creating account...';
  try {
    await signUp(email, password, name);
    document.getElementById('auth-error').style.color = '#81c784';
    document.getElementById('auth-error').textContent = 'Account created! Signing you in...';
  } catch (err) { document.getElementById('auth-error').textContent = err.message; btn.disabled = false; btn.textContent = 'Create Account'; }
}
async function handleSignOut() {
  if (typeof conversationHistory !== 'undefined' && conversationHistory.length > 0) await endSession(currentUser.id);
  await signOut();
}
async function startUserSession() {
  const name = currentUser.user_metadata?.preferred_name;
  if (name) document.getElementById('user-greeting').textContent = `Hi ${name} — your session is private`;
  await initSession(currentUser.id);
  showScreen('adkar-screen');
}
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
  messages.scrollTop = messages.scrollHeight;
}
function showTyping(visible) {
  document.getElementById('typing').classList.toggle('visible', visible);
  document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
}
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
