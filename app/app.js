let currentUser = null;
let adkarScores = {};
let appShown = false;

// Phase B: cooldown so users can't spam "Send me a login link" and burn their
// Supabase email rate limit. 60s matches the typical delivery window.
const MAGIC_LINK_COOLDOWN_MS = 60_000;
let magicLinkCooldownTimer = null;

window.addEventListener('DOMContentLoaded', async () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(console.error);
  }

  // NOTE: Do NOT manually clean up the #access_token hash here.
  // supabase-js v2 (detectSessionInUrl: true, which is the default) parses the
  // hash asynchronously on client init and cleans up the URL itself once the
  // session is captured. A manual history.replaceState in DOMContentLoaded
  // races with that async parse and, on slower devices like mobile, wipes the
  // tokens before supabase-js can read them — breaking cross-device magic-link
  // sign-in. Verified 2026-04-18: removing the manual cleanup fixes phone
  // clicks after laptop-initiated signup. (Diagnosed from auth logs showing
  // server-side verify succeeded but client-side session never established.)

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

  // Resolve the best-known preferred name:
  //   1. auth.user_metadata (set via signInWithOtp options.data — survives cross-device)
  //   2. localStorage fallback (for users who signed up on the old version before deploy)
  const metaName = user.user_metadata?.preferred_name || null;
  const legacyStoredName = localStorage.getItem('tether_preferred_name');
  const bestName = metaName || legacyStoredName || null;

  // The server-side trigger has already created a user_profiles row with whatever
  // name was in raw_user_meta_data at signup time. This upsert fills it in
  // post-hoc for users who came in via the legacy localStorage path, or updates
  // an older name if user_metadata was updated. Safe to run unconditionally.
  if (bestName) {
    try {
      if (metaName !== bestName) {
        await supabaseClient.auth.updateUser({ data: { preferred_name: bestName } });
      }
      await supabaseClient
        .from('user_profiles')
        .upsert({ id: user.id, preferred_name: bestName }, { onConflict: 'id' });
    } catch (e) {
      console.error('Could not save preferred name:', e);
      // Fire and forget — never block user flow on observability
      logSignupError('post_auth_upsert', {
        message: e?.message,
        code: e?.code,
        email: user.email,
        metadata: { name_source: metaName ? 'auth_metadata' : 'localStorage' }
      });
    }
  }
  // Clean up legacy localStorage once we've migrated it
  if (legacyStoredName) {
    localStorage.removeItem('tether_preferred_name');
  }

  await startUserSession();
}

// ─── Corporate Email Detection ─────────────────────────────────────
// Phase B: HARD BLOCK. Work emails disable the submit button and show an
// error-style message. The privacy promise is the whole product — we do not
// allow employer-visible email addresses into the user base.
function checkCorporateEmail(value) {
  const warningEl = document.getElementById('corp-email-warning');
  const btn = document.getElementById('magic-btn');
  const errorEl = document.getElementById('auth-error');

  if (!warningEl || !btn) return;

  // Not enough typed yet to decide — neutral state.
  if (!value || !value.includes('@')) {
    warningEl.style.display = 'none';
    // Only re-enable if we're not in cooldown from a prior send.
    if (!magicLinkCooldownTimer) {
      btn.disabled = false;
    }
    if (errorEl) errorEl.textContent = '';
    return;
  }

  const domainPart = value.split('@')[1];
  // Domain still being typed (e.g. "x@" or "x@gm") — don't judge yet.
  if (!domainPart || !domainPart.includes('.')) {
    warningEl.style.display = 'none';
    if (!magicLinkCooldownTimer) btn.disabled = false;
    return;
  }

  if (isPersonalEmail(value)) {
    warningEl.style.display = 'none';
    if (!magicLinkCooldownTimer) btn.disabled = false;
    if (errorEl) errorEl.textContent = '';
  } else {
    warningEl.style.display = 'block';
    btn.disabled = true;
  }
}

// ─── Magic Link Send ───────────────────────────────────────────────
async function handleMagicLink() {
  const emailInput = document.getElementById('magic-email');
  const nameInput = document.getElementById('magic-name');
  const btn = document.getElementById('magic-btn');
  const errorEl = document.getElementById('auth-error');
  const email = emailInput.value.trim().toLowerCase();
  const preferredName = nameInput.value.trim();

  // Basic format check
  if (!email || !email.includes('@') || !email.includes('.')) {
    errorEl.textContent = 'Please enter a valid email address.';
    return;
  }

  // Phase B HARD BLOCK: work email refused at submit time, not just warned.
  // Defense in depth — the button is already disabled by checkCorporateEmail
  // when a work email is detected, but if that UI state is bypassed we still
  // refuse here and log the attempt.
  if (!isPersonalEmail(email)) {
    errorEl.textContent =
      "Please use a personal email (Gmail, Yahoo, iCloud, Outlook, etc.) to sign up. " +
      "Work emails aren't accepted — this keeps your conversations fully separate from your employer.";
    logSignupError('work_email_blocked', {
      email,
      message: 'Work email submission rejected by client-side block',
      metadata: { domain: email.split('@')[1] }
    });
    return;
  }

  // Store name locally as a belt-and-suspenders fallback (if user opens the
  // link in the same browser, we'll pick this up in enterApp). The primary
  // path is options.data → raw_user_meta_data, which survives cross-device.
  if (preferredName) {
    localStorage.setItem('tether_preferred_name', preferredName);
  }

  errorEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Sending link...';

  try {
    await sendMagicLink(email, preferredName);

    // Success: show check-your-email state + arm the cooldown.
    document.getElementById('magic-form').style.display = 'none';
    document.getElementById('check-email').style.display = 'block';
    document.getElementById('sent-email-display').textContent = email;
    armMagicLinkCooldown();

  } catch (err) {
    const { friendly, code, isRateLimit } = classifyAuthError(err);
    errorEl.textContent = friendly;

    logSignupError('magic_link_send', {
      email,
      code,
      message: err?.message,
      metadata: { isRateLimit }
    });

    // On rate-limit, also arm the cooldown so the user doesn't immediately
    // retry and make it worse. On other errors, re-enable the button so they
    // can fix and retry.
    if (isRateLimit) {
      armMagicLinkCooldown();
    } else {
      btn.disabled = false;
      btn.textContent = 'Send me a login link';
    }
  }
}

// ─── Cooldown management for the "Send me a login link" button ────
function armMagicLinkCooldown() {
  const btn = document.getElementById('magic-btn');
  if (!btn) return;
  btn.disabled = true;

  const startedAt = Date.now();
  if (magicLinkCooldownTimer) clearInterval(magicLinkCooldownTimer);

  const tick = () => {
    const remainingMs = MAGIC_LINK_COOLDOWN_MS - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      clearInterval(magicLinkCooldownTimer);
      magicLinkCooldownTimer = null;
      btn.disabled = false;
      btn.textContent = 'Send me a login link';
      return;
    }
    const s = Math.ceil(remainingMs / 1000);
    btn.textContent = `Check your email (resend in ${s}s)`;
  };
  tick();
  magicLinkCooldownTimer = setInterval(tick, 1000);
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
  // Note: we deliberately do NOT clear the cooldown here — the rate limit
  // still applies to the prior email. If the user enters a different email,
  // the button will re-enable once the cooldown expires.
}

async function handleSignOut() {
  if (typeof conversationHistory !== 'undefined' && conversationHistory.length > 0) await endSession(currentUser.id);
  appShown = false;
  await signOut();
}

async function startUserSession() {
  const name = currentUser.user_metadata?.preferred_name || currentUser.email?.split('@')[0];
  if (name) {
    document.getElementById('user-greeting').textContent = `Hi ${name} — your session is private`;
    // Personalize the big welcome card on chat-screen too (mirrors subtitle pattern above).
    // Fallback copy in the HTML remains for users with no known name.
    const welcomeStrong = document.getElementById('welcome-greeting');
    if (welcomeStrong) {
      welcomeStrong.textContent = `Hi ${name} — I'm Tether, your resilience coach.`;
    }
  }
  await initSession(currentUser.id);
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
  try {
    await saveAdkarScores(currentUser.id, adkarScores, changeContext);
  } catch (e) {
    logSignupError('adkar_submit', {
      message: e?.message, code: e?.code,
      email: currentUser?.email, metadata: { change_context: changeContext }
    });
  }
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
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
function formatCoachText(text) {
  return escapeHtml(text).replace(/\n\n/g, '<br><br>').replace(/\n/g, '<br>');
}
function addMessage(role, content) {
  const messages = document.getElementById('messages');
  const welcome = messages.querySelector('.welcome-msg');
  if (welcome) welcome.remove();
  const div = document.createElement('div');
  div.className = `message ${role}`;
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const safeContent = role === 'user' ? escapeHtml(content) : formatCoachText(content);
  div.innerHTML = `<div class="message-bubble">${safeContent}</div><div class="message-time">${time}</div>`;
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
