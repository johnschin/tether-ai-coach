let currentUser = null;
let adkarScores = {};
let appShown = false;

// Phase B: cooldown so users can't spam "Send me a login link" and burn their
// Supabase email rate limit. 60s matches the typical delivery window.
const MAGIC_LINK_COOLDOWN_MS = 60_000;
let magicLinkCooldownTimer = null;

// Phase C: a redemption status carried from enterApp → startUserSession, so
// we can render a banner on the adkar-screen after the signup-code was just
// applied (or failed). Values: null | { status, companyId }.
let pendingRedeemStatus = null;

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

  // Defense in depth: ensure a user_profiles row exists for this user,
  // regardless of whether we have a name. The `on_auth_user_created`
  // trigger creates one on signup, but its EXCEPTION block swallows
  // failures silently — so we upsert here to guarantee downstream code
  // (ADKAR save, memory fetch, RLS admin helpers) has a row to work with.
  const profileUpsert = { id: user.id };
  if (bestName) profileUpsert.preferred_name = bestName;
  try {
    if (bestName && metaName !== bestName) {
      await supabaseClient.auth.updateUser({ data: { preferred_name: bestName } });
    }
    await supabaseClient
      .from('user_profiles')
      .upsert(profileUpsert, { onConflict: 'id' });
  } catch (e) {
    console.error('Could not ensure user_profiles row:', e);
    // Fire and forget — never block user flow on observability
    logSignupError('post_auth_upsert', {
      message: e?.message,
      code: e?.code,
      email: user.email,
      metadata: {
        name_source: metaName ? 'auth_metadata' : (legacyStoredName ? 'localStorage' : 'none'),
        has_name: !!bestName
      }
    });
  }
  // Clean up legacy localStorage once we've migrated it
  if (legacyStoredName) {
    localStorage.removeItem('tether_preferred_name');
  }

  // Phase C: attempt signup-code redemption if one was captured at signup.
  // No-op if auth metadata doesn't carry a signup_code. Non-blocking on
  // failure — the user enters the app with company_id = NULL and can be
  // linked later via admin tooling.
  await maybeRedeemSignupCode(user);

  await startUserSession();
}

// ─── Signup-code redemption (Phase C) ──────────────────────────────
// One-shot attempt triggered on the first sign-in after signup. Reads the
// code from auth.user_metadata.signup_code (populated by sendMagicLink at
// signup time), calls the SECURITY DEFINER `redeem_signup_code` RPC, and
// records the outcome for the banner shown on adkar-screen.
//
// Metadata clearing policy: we clear signup_code from auth metadata on
// every TERMINAL outcome (ok / already_redeemed / invalid / inactive /
// expired / exhausted). We do NOT clear on unexpected RPC errors (network,
// 500s) so those can be retried on the next sign-in. Trade-off: a typo'd
// code will get one attempt then disappear — the user can't keep retrying
// on every sign-in. They'd need to get a fresh code + admin to re-link.
async function maybeRedeemSignupCode(user) {
  const rawCode = user.user_metadata?.signup_code;
  if (!rawCode || typeof rawCode !== 'string' || !rawCode.trim()) return;
  const code = rawCode.trim();

  let status = null;
  let companyId = null;
  let rpcThrew = false;

  try {
    const { data, error } = await supabaseClient.rpc('redeem_signup_code', {
      code_input: code,
      user_id_input: user.id,
    });
    if (error) throw error;
    if (Array.isArray(data) && data.length > 0) {
      status = data[0].status;
      companyId = data[0].company_id;
    }
  } catch (e) {
    rpcThrew = true;
    console.warn('[signup-code] RPC threw:', e?.message || e);
    logSignupError('signup_code_redeem', {
      email: user.email,
      message: e?.message,
      code: e?.code,
      metadata: { code_attempted: code.slice(0, 64), stage: 'rpc_threw' }
    });
  }

  // Log any deterministic non-success outcome for pilot-day observability.
  if (!rpcThrew && status && status !== 'ok' && status !== 'already_redeemed') {
    logSignupError('signup_code_redeem', {
      email: user.email,
      message: `Code rejected: ${status}`,
      metadata: { code_attempted: code.slice(0, 64), status }
    });
  }

  // Clear the code from auth metadata on any terminal RPC outcome so a
  // bad code doesn't retry forever on every sign-in. On transport-level
  // failures (rpcThrew), keep it for a next-sign-in retry.
  if (!rpcThrew) {
    try {
      await supabaseClient.auth.updateUser({ data: { signup_code: null } });
    } catch (e) {
      console.warn('[signup-code] could not clear metadata:', e?.message || e);
    }
  }

  pendingRedeemStatus = { status: status || (rpcThrew ? 'error' : 'unknown'), companyId };
}

// Renders a small dismissible banner at the top of the adkar-screen to
// confirm (or acknowledge the failure of) a signup-code redemption. No
// new HTML — the element is created and inserted here to keep the index
// surface minimal. Silent on 'already_redeemed' (no-op from the user's
// perspective) and on null (no code was ever submitted).
function showRedeemBanner() {
  if (!pendingRedeemStatus) return;
  const { status } = pendingRedeemStatus;
  if (!status || status === 'already_redeemed') return;

  const isSuccess = status === 'ok';
  const message = isSuccess
    ? "Access code applied. You're linked to your company's pilot."
    : "We couldn't apply that access code. You can continue — reach out to your admin if you need to link your company later.";
  const fg = isSuccess ? '#3f6a4a' : '#8a6d3b';
  const bg = isSuccess ? '#eef6f0' : '#fff8f0';
  const br = isSuccess ? '#c5dfc9' : '#f0d8b5';

  const screen = document.getElementById('adkar-screen');
  if (!screen) return;
  const existing = document.getElementById('redeem-banner');
  if (existing) existing.remove();

  const banner = document.createElement('div');
  banner.id = 'redeem-banner';
  banner.setAttribute('role', 'status');
  banner.style.cssText =
    `background:${bg};border:1px solid ${br};border-radius:8px;` +
    `padding:12px 14px;margin-bottom:20px;font-size:13px;color:${fg};` +
    `line-height:1.5;display:flex;justify-content:space-between;` +
    `align-items:flex-start;gap:12px;`;
  const span = document.createElement('span');
  span.textContent = message;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Dismiss');
  btn.textContent = '\u00d7';
  btn.style.cssText =
    `background:none;border:none;color:inherit;cursor:pointer;` +
    `font-size:20px;padding:0 4px;line-height:1;flex-shrink:0;`;
  btn.addEventListener('click', () => banner.remove());
  banner.appendChild(span);
  banner.appendChild(btn);
  screen.insertBefore(banner, screen.firstChild);

  // One-shot — consume the pending status.
  pendingRedeemStatus = null;
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

  // isAllowedEmail covers personal-email domains AND the explicit ADMIN_EMAILS
  // allowlist (auth.js), so internal admin accounts on custom domains
  // (e.g. john@guidetoself.com) don't get the orange "use personal email"
  // warning and don't have the submit button disabled.
  if (isAllowedEmail(value)) {
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
  const codeInput = document.getElementById('magic-signup-code');
  const btn = document.getElementById('magic-btn');
  const errorEl = document.getElementById('auth-error');
  const email = emailInput.value.trim().toLowerCase();
  const preferredName = nameInput.value.trim();
  // Phase C: optional company signup code. Blank is fine — redemption is
  // only attempted post-sign-in when this value made it into auth metadata.
  const signupCode = codeInput ? codeInput.value.trim() : '';

  // Basic format check
  if (!email || !email.includes('@') || !email.includes('.')) {
    errorEl.textContent = 'Please enter a valid email address.';
    return;
  }

  // Phase B HARD BLOCK: work email refused at submit time, not just warned.
  // Defense in depth — the button is already disabled by checkCorporateEmail
  // when a work email is detected, but if that UI state is bypassed we still
  // refuse here and log the attempt.
  // isAllowedEmail bypasses the block for the explicit ADMIN_EMAILS allowlist
  // in auth.js (Tether-internal admin accounts on custom domains).
  if (!isAllowedEmail(email)) {
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
    await sendMagicLink(email, preferredName, signupCode);

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
  const codeInput = document.getElementById('magic-signup-code');
  if (codeInput) codeInput.value = '';
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
  // Phase C: render the signup-code redemption banner AFTER the adkar
  // screen is visible so the DOM insertion takes effect. No-op if no
  // code was submitted (pendingRedeemStatus is null).
  showRedeemBanner();
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
