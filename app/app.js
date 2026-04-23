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

// Phase D (2026-04-21): consent version string. Must match the
// data-consent-version attribute on #consent-screen in index.html AND the
// visible copy in the consent body — bump all three in lockstep whenever
// we revise the consent text.
const CONSENT_VERSION = 'tether-v1-2026-04';

// Phase F (2026-04-22): trial-ended reason carried into showTrialEndedScreen
// so we can surface slightly different copy. Values: null | string.
let trialEndReason = null;

window.addEventListener('DOMContentLoaded', async () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(console.error);
  }

  const session = await getSession();
  if (session?.user) {
    enterApp(session.user);
  } else if (!document.documentElement.classList.contains('auth-callback')) {
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

// ─── Auth Helpers ──────────────────────────────────────────────────────────
async function enterApp(user) {
  if (appShown) return;
  appShown = true;
  currentUser = user;

  const metaName        = user.user_metadata?.preferred_name || null;
  const legacyStoredName = localStorage.getItem('tether_preferred_name');
  const bestName         = metaName || legacyStoredName || null;

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
    logSignupError('post_auth_upsert', {
      message:  e?.message,
      code:     e?.code,
      email:    user.email,
      metadata: {
        name_source: metaName ? 'auth_metadata' : (legacyStoredName ? 'localStorage' : 'none'),
        has_name:    !!bestName
      }
    });
  }
  if (legacyStoredName) localStorage.removeItem('tether_preferred_name');

  await maybeRedeemSignupCode(user);

  const consented = await hasConsented(user.id);
  if (consented) {
    await startUserSession();
  } else {
    showScreen('consent-screen');
  }
}

// ─── Signup-code redemption (Phase C) ──────────────────────────────────────
async function maybeRedeemSignupCode(user) {
  const rawCode = user.user_metadata?.signup_code;
  if (!rawCode || typeof rawCode !== 'string' || !rawCode.trim()) return;
  const code = rawCode.trim();

  let status    = null;
  let companyId = null;
  let rpcThrew  = false;

  try {
    const { data, error } = await supabaseClient.rpc('redeem_signup_code', {
      code_input:    code,
      user_id_input: user.id,
    });
    if (error) throw error;
    if (Array.isArray(data) && data.length > 0) {
      status    = data[0].status;
      companyId = data[0].company_id;
    }
  } catch (e) {
    rpcThrew = true;
    console.warn('[signup-code] RPC threw:', e?.message || e);
    logSignupError('signup_code_redeem', {
      email:    user.email,
      message:  e?.message,
      code:     e?.code,
      metadata: { code_attempted: code.slice(0, 64), stage: 'rpc_threw' }
    });
  }

  if (!rpcThrew && status && status !== 'ok' && status !== 'already_redeemed') {
    logSignupError('signup_code_redeem', {
      email:    user.email,
      message:  `Code rejected: ${status}`,
      metadata: { code_attempted: code.slice(0, 64), status }
    });
  }

  if (!rpcThrew) {
    try {
      await supabaseClient.auth.updateUser({ data: { signup_code: null } });
    } catch (e) {
      console.warn('[signup-code] could not clear metadata:', e?.message || e);
    }
  }

  pendingRedeemStatus = { status: status || (rpcThrew ? 'error' : 'unknown'), companyId };
}

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
  pendingRedeemStatus = null;
}

// ─── Consent gate (Phase D) ────────────────────────────────────────────────
async function hasConsented(userId) {
  if (!userId) return false;
  try {
    const { data, error } = await supabaseClient
      .from('consent_events')
      .select('id')
      .eq('user_id', userId)
      .in('event_type', ['initial_consent', 'reacknowledged'])
      .eq('consent_text_shown', CONSENT_VERSION)
      .limit(1);
    if (error) { console.warn('[consent] check failed:', error.message); return false; }
    return Array.isArray(data) && data.length > 0;
  } catch (e) {
    console.warn('[consent] check threw:', e?.message || e);
    return false;
  }
}

async function handleConsentAcknowledge() {
  const btn       = document.getElementById('consent-accept-btn');
  const errorEl   = document.getElementById('consent-error');
  const declineBtn = document.getElementById('consent-decline-btn');
  const screen    = document.getElementById('consent-screen');
  const versionFromDom = screen?.dataset?.consentVersion || CONSENT_VERSION;

  if (errorEl)    errorEl.textContent = '';
  if (btn)        { btn.disabled = true; btn.textContent = 'Saving\u2026'; }
  if (declineBtn) declineBtn.disabled = true;

  let status   = null;
  let rpcThrew = false;

  try {
    const { data, error } = await supabaseClient.rpc('record_consent', {
      event_type_input:     'initial_consent',
      consent_version_input: versionFromDom,
      user_agent_input:     (navigator.userAgent || '').slice(0, 1000),
    });
    if (error) throw error;
    if (Array.isArray(data) && data.length > 0) status = data[0].status;
  } catch (e) {
    rpcThrew = true;
    console.error('[consent] RPC threw:', e?.message || e);
    logSignupError('consent_record', {
      email:    currentUser?.email,
      message:  e?.message,
      code:     e?.code,
      metadata: { consent_version: versionFromDom, stage: 'rpc_threw' }
    });
  }

  if (!rpcThrew && (status === 'ok' || status === 'already_recorded')) {
    await startUserSession();
    return;
  }

  if (!rpcThrew && status) {
    logSignupError('consent_record', {
      email:    currentUser?.email,
      message:  `Consent RPC returned status: ${status}`,
      metadata: { consent_version: versionFromDom, status }
    });
  }

  if (errorEl) {
    errorEl.textContent = rpcThrew
      ? 'Something went wrong saving your acknowledgement. Please try again in a moment.'
      : 'We couldn\u2019t save your acknowledgement. Please try again.';
  }
  if (btn)        { btn.disabled = false; btn.textContent = 'I agree and continue'; }
  if (declineBtn) declineBtn.disabled = false;
}

async function handleConsentDecline() {
  const btn       = document.getElementById('consent-decline-btn');
  const acceptBtn = document.getElementById('consent-accept-btn');
  if (btn)       btn.disabled = true;
  if (acceptBtn) acceptBtn.disabled = true;

  try { await signOut(); } catch (e) {
    console.warn('[consent] sign-out on decline failed:', e?.message || e);
  }

  currentUser           = null;
  appShown              = false;
  pendingRedeemStatus   = null;
  showScreen('auth-screen');

  if (btn)       btn.disabled = false;
  if (acceptBtn) acceptBtn.disabled = false;
}

// ─── Corporate Email Detection ─────────────────────────────────────────────
function checkCorporateEmail(value) {
  const warningEl = document.getElementById('corp-email-warning');
  const btn       = document.getElementById('magic-btn');
  const errorEl   = document.getElementById('auth-error');

  if (!warningEl || !btn) return;

  if (!value || !value.includes('@')) {
    warningEl.style.display = 'none';
    if (!magicLinkCooldownTimer) btn.disabled = false;
    if (errorEl) errorEl.textContent = '';
    return;
  }

  const domainPart = value.split('@')[1];
  if (!domainPart || !domainPart.includes('.')) {
    warningEl.style.display = 'none';
    if (!magicLinkCooldownTimer) btn.disabled = false;
    return;
  }

  if (isAllowedEmail(value)) {
    warningEl.style.display = 'none';
    if (!magicLinkCooldownTimer) btn.disabled = false;
    if (errorEl) errorEl.textContent = '';
  } else {
    warningEl.style.display = 'block';
    btn.disabled = true;
  }
}

// ─── Magic Link Send ───────────────────────────────────────────────────────
async function handleMagicLink() {
  const emailInput   = document.getElementById('magic-email');
  const nameInput    = document.getElementById('magic-name');
  const codeInput    = document.getElementById('magic-signup-code');
  const btn          = document.getElementById('magic-btn');
  const errorEl      = document.getElementById('auth-error');
  const email        = emailInput.value.trim().toLowerCase();
  const preferredName = nameInput.value.trim();
  const signupCode   = codeInput ? codeInput.value.trim() : '';

  if (!email || !email.includes('@') || !email.includes('.')) {
    errorEl.textContent = 'Please enter a valid email address.';
    return;
  }

  if (!isAllowedEmail(email)) {
    errorEl.textContent =
      "Please use a personal email (Gmail, Yahoo, iCloud, Outlook, etc.) to sign up. " +
      "Work emails aren't accepted \u2014 this keeps your conversations fully separate from your employer.";
    logSignupError('work_email_blocked', {
      email,
      message:  'Work email submission rejected by client-side block',
      metadata: { domain: email.split('@')[1] }
    });
    return;
  }

  if (preferredName) localStorage.setItem('tether_preferred_name', preferredName);

  errorEl.textContent  = '';
  btn.disabled         = true;
  btn.textContent      = 'Sending link...';

  try {
    await sendMagicLink(email, preferredName, signupCode);
    document.getElementById('magic-form').style.display  = 'none';
    document.getElementById('check-email').style.display = 'block';
    document.getElementById('sent-email-display').textContent = email;
    armMagicLinkCooldown();
  } catch (err) {
    const { friendly, code, isRateLimit } = classifyAuthError(err);
    errorEl.textContent = friendly;
    logSignupError('magic_link_send', { email, code, message: err?.message, metadata: { isRateLimit } });
    if (isRateLimit) {
      armMagicLinkCooldown();
    } else {
      btn.disabled    = false;
      btn.textContent = 'Send me a login link';
    }
  }
}

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
      btn.disabled    = false;
      btn.textContent = 'Send me a login link';
      return;
    }
    btn.textContent = `Check your email (resend in ${Math.ceil(remainingMs / 1000)}s)`;
  };
  tick();
  magicLinkCooldownTimer = setInterval(tick, 1000);
}

function resetMagicForm() {
  document.getElementById('magic-form').style.display  = 'block';
  document.getElementById('check-email').style.display = 'none';
  document.getElementById('auth-error').textContent    = '';
  const warning = document.getElementById('corp-email-warning');
  if (warning) warning.style.display = 'none';
  document.getElementById('magic-name').value   = '';
  document.getElementById('magic-email').value  = '';
  const codeInput = document.getElementById('magic-signup-code');
  if (codeInput) codeInput.value = '';
  document.getElementById('magic-name').focus();
}

async function handleSignOut() {
  // Phase G: close sidebar before signing out (it's position:fixed and survives screen transitions)
  closeSidebar();
  if (typeof conversationHistory !== 'undefined' && conversationHistory.length > 0) {
    await endSession(currentUser.id);
  }
  appShown = false;
  await signOut();
}

async function startUserSession() {
  const name = currentUser.user_metadata?.preferred_name || currentUser.email?.split('@')[0];
  if (name) {
    document.getElementById('user-greeting').textContent = `Hi ${name} \u2014 your session is private`;
    const welcomeStrong = document.getElementById('welcome-greeting');
    if (welcomeStrong) welcomeStrong.textContent = `Hi ${name} \u2014 I'm Tether, your resilience coach.`;
  }

  // Phase F: reset per-session prompt counter
  if (typeof resetSessionPromptCount === 'function') resetSessionPromptCount();

  // Phase F: initialise trial status bar (hidden until first trial response arrives)
  const statusBar = document.getElementById('trial-status-bar');
  if (statusBar) {
    statusBar.style.display = 'none';
  }

  // Phase G: show hamburger button now that a session is active
  const hamburgerBtn = document.getElementById('hamburger-btn');
  if (hamburgerBtn) hamburgerBtn.style.display = 'flex';

  await initSession(currentUser.id);
  showScreen('adkar-screen');
  showRedeemBanner();
}

// ─── Phase F: Trial UI helpers ─────────────────────────────────────────────

// Called by coaching.js after every successful chat that includes trial_status.
function updateTrialStatusBar(trialStatus) {
  const bar     = document.getElementById('trial-status-bar');
  const textEl  = document.getElementById('trial-status-text');
  if (!bar || !textEl || !trialStatus) return;

  const remaining = trialStatus.prompts_remaining;
  const used      = trialStatus.prompts_used;
  const startedAt = trialStatus.started_at;

  // Days remaining
  let daysText = '';
  if (startedAt) {
    const expiryMs  = new Date(startedAt).getTime() + 14 * 86_400_000;
    const daysLeft  = Math.ceil((expiryMs - Date.now()) / 86_400_000);
    if (daysLeft > 0) daysText = ` \u00b7 ${daysLeft}d left`;
  }

  textEl.textContent = `Free trial \u00b7 ${remaining} prompt${remaining !== 1 ? 's' : ''} remaining${daysText}`;

  // Colour shifts as limit approaches
  if (remaining <= 5) {
    bar.className = 'trial-status-bar trial-status-bar--urgent';
  } else if (remaining <= 15) {
    bar.className = 'trial-status-bar trial-status-bar--warning';
  } else {
    bar.className = 'trial-status-bar';
  }

  bar.style.display = 'flex';
}

// Called by coaching.js when the worker returns 403 trial_expired.
function handleTrialExpired(reason) {
  trialEndReason = reason || 'prompts_exhausted';
  showTrialEndedScreen(trialEndReason);
}

// Transitions to the trial-ended screen and pre-fills the pilot interest form.
function showTrialEndedScreen(reason) {
  // Guard against double-call
  if (document.getElementById('trial-ended-screen')?.classList.contains('active')) return;

  trialEndReason = reason || 'prompts_exhausted';

  if (currentUser) {
    const nameEl    = document.getElementById('pilot-name');
    const emailEl   = document.getElementById('pilot-email');
    const metaName  = currentUser.user_metadata?.preferred_name || '';
    if (nameEl)  nameEl.value  = metaName;
    if (emailEl) emailEl.value = currentUser.email || '';
  }

  const reasonEl = document.getElementById('trial-end-reason');
  if (reasonEl) {
    if (reason === 'time_limit') {
      reasonEl.textContent = 'Your 14-day free trial has ended.';
    } else {
      reasonEl.textContent = 'You\u2019ve used all 60 prompts in your free trial.';
    }
  }

  showScreen('trial-ended-screen');
}

// Advisory banner shown inside chat when session hits 20 prompts.
function showSessionLimitBanner() {
  if (document.getElementById('session-limit-banner')) return;

  const messages = document.getElementById('messages');
  if (!messages) return;

  const banner = document.createElement('div');
  banner.id = 'session-limit-banner';
  banner.style.cssText =
    'background:#f7f5f0;border:1px solid var(--sand);border-radius:10px;' +
    'padding:14px 16px;margin:8px 0;font-size:13px;color:var(--plum);' +
    'line-height:1.55;text-align:center;';
  banner.innerHTML =
    'You\u2019ve reached 20 prompts in this session \u2014 a natural stopping point. ' +
    'When you\u2019re ready, click <strong>End Session</strong> to save your progress and ' +
    'start fresh. You have ' +
    (typeof getTrialStatus === 'function' && getTrialStatus()
      ? `${getTrialStatus().prompts_remaining} trial prompts remaining overall.`
      : 'additional trial prompts remaining.') +
    '';
  messages.appendChild(banner);
  messages.scrollTop = messages.scrollHeight;
}

// ─── Phase F: Pilot study interest form ───────────────────────────────────
async function handlePilotInterestSubmit() {
  const btn     = document.getElementById('pilot-submit-btn');
  const errorEl = document.getElementById('pilot-error');
  const nameEl  = document.getElementById('pilot-name');
  const emailEl = document.getElementById('pilot-email');
  const coEl    = document.getElementById('pilot-company');
  const notesEl = document.getElementById('pilot-notes');

  if (errorEl) errorEl.textContent = '';
  if (btn)     { btn.disabled = true; btn.textContent = 'Registering\u2026'; }

  if (!currentUser) {
    if (errorEl) errorEl.textContent = 'Your session has expired. Please sign out and sign back in.';
    if (btn)     { btn.disabled = false; btn.textContent = 'Register Interest'; }
    return;
  }

  try {
    const trialStatus = typeof getTrialStatus === 'function' ? getTrialStatus() : null;

    const { error } = await supabaseClient
      .from('pilot_study_interest')
      .insert({
        user_id:       currentUser?.id || null,
        email:         emailEl?.value?.trim() || currentUser?.email || '',
        preferred_name: nameEl?.value?.trim() || null,
        company:       coEl?.value?.trim()    || null,
        notes:         notesEl?.value?.trim() || null,
        prompts_used:  trialStatus?.prompts_used ?? null,
        trial_reason:  trialEndReason || 'prompts_exhausted'
      });

    if (error) throw error;

    const form        = document.getElementById('pilot-interest-form');
    const successMsg  = document.getElementById('pilot-interest-success');
    if (form)       form.style.display = 'none';
    if (successMsg) successMsg.style.display = 'block';

  } catch (e) {
    console.error('[pilot-interest] submit failed:', e?.message || e);
    if (errorEl) errorEl.textContent = 'Something went wrong. Please try again in a moment, or reach out to your HR or L&D team for assistance.';
    if (btn)     { btn.disabled = false; btn.textContent = 'Register Interest'; }
  }
}

// ─── Phase G: Copy conversation ────────────────────────────────────────────
// Reads the live conversationHistory array via getConversationHistory()
// (defined in coaching.js), formats as plain text, copies to clipboard.
function copyConversation() {
  const history = typeof getConversationHistory === 'function'
    ? getConversationHistory()
    : [];

  if (!history || history.length === 0) {
    alert('No conversation to copy yet — start chatting first.');
    return;
  }

  const text = history.map(function(msg) {
    const label = msg.role === 'user' ? 'You' : 'Tether';
    return label + ':\n' + msg.content;
  }).join('\n\n---\n\n');

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function() {
      showCopyFeedback();
    }).catch(function() {
      fallbackCopy(text);
    });
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const el = document.createElement('textarea');
  el.value = text;
  el.setAttribute('readonly', '');
  el.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
  document.body.appendChild(el);
  el.select();
  try {
    document.execCommand('copy');
    showCopyFeedback();
  } catch (e) {
    alert('Copy failed. Please select and copy the text manually.');
  }
  document.body.removeChild(el);
}

function showCopyFeedback() {
  const btn = document.getElementById('copy-btn');
  if (!btn) return;
  const originalText = btn.textContent;
  btn.textContent = 'Copied!';
  btn.disabled = true;
  setTimeout(function() {
    btn.textContent = originalText;
    btn.disabled = false;
  }, 2000);
}

// ─── Phase G: Session history sidebar ─────────────────────────────────────
// Hamburger button toggles a slide-in panel showing past session summaries
// from the session_summaries table (user_id, session_date, summary, themes,
// emotional_tone). Requires RLS SELECT policy — see phase_g_rls.sql.

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
}

function openSidebar() {
  const sidebar      = document.getElementById('sidebar');
  const overlay      = document.getElementById('sidebar-overlay');
  const hamburgerBtn = document.getElementById('hamburger-btn');
  if (!sidebar || !overlay) return;
  sidebar.classList.add('open');
  overlay.classList.add('open');
  if (hamburgerBtn) hamburgerBtn.classList.add('open');
  loadSessionHistory();
}

function closeSidebar() {
  const sidebar      = document.getElementById('sidebar');
  const overlay      = document.getElementById('sidebar-overlay');
  const hamburgerBtn = document.getElementById('hamburger-btn');
  if (!sidebar || !overlay) return;
  sidebar.classList.remove('open');
  overlay.classList.remove('open');
  if (hamburgerBtn) hamburgerBtn.classList.remove('open');
}

async function loadSessionHistory() {
  const container = document.getElementById('sidebar-sessions');
  if (!container) return;

  // Guard: should never happen since hamburger is only shown after session starts,
  // but defensive check prevents crash if somehow called without a user.
  if (!currentUser) {
    container.innerHTML = '<div class="sidebar-empty">Please sign in to view past sessions.</div>';
    return;
  }

  container.innerHTML = '<div class="sidebar-loading">Loading sessions\u2026</div>';

  try {
    const { data, error } = await supabaseClient
      .from('session_summaries')
      .select('title, summary, pillar, topics, message_count, created_at')
      .eq('user_id', currentUser.id)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) throw error;

    if (!data || data.length === 0) {
      container.innerHTML =
        '<div class="sidebar-empty">' +
        'No past sessions yet.<br>End a session to save your first summary.' +
        '</div>';
      return;
    }

    container.innerHTML = '';
    data.forEach(function(session) {
      const item = document.createElement('div');
      item.className = 'sidebar-session-item';

      // Date from created_at (timestamptz)
      const dateStr = session.created_at
        ? new Date(session.created_at).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric'
          })
        : 'Session';

      // Pillar badge — maps Tether's four pillars to colors
      const rawPillar = (session.pillar || '').toLowerCase().trim();
      const pillarColors = {
        stress:                  'background:#fff8e1;color:#f57f17;',
        stress_burnout:          'background:#fff8e1;color:#f57f17;',
        burnout:                 'background:#fff8e1;color:#f57f17;',
        anger:                   'background:#fce4ec;color:#c62828;',
        anger_reactivity:        'background:#fce4ec;color:#c62828;',
        reactivity:              'background:#fce4ec;color:#c62828;',
        relationships:           'background:#e0f7fa;color:#00838f;',
        relationships_communication: 'background:#e0f7fa;color:#00838f;',
        communication:           'background:#e0f7fa;color:#00838f;',
        identity:                'background:#ede7f6;color:#4527a0;',
        identity_meaning:        'background:#ede7f6;color:#4527a0;',
        meaning:                 'background:#ede7f6;color:#4527a0;',
      };
      const pillarStyle = pillarColors[rawPillar] || 'background:var(--cream);color:var(--muted);';
      const pillarBadge = rawPillar
        ? '<span class="tone-badge" style="' + pillarStyle + '">' + escapeHtml(session.pillar) + '</span>'
        : '';

      // Message count sub-label
      const msgCount = session.message_count
        ? '<span class="session-msg-count">' + session.message_count + ' messages</span>'
        : '';

      // Topic chips — column is named 'topics' in the actual schema
      let topicsHtml = '';
      if (Array.isArray(session.topics) && session.topics.length > 0) {
        topicsHtml =
          '<div class="session-themes">' +
          session.topics.slice(0, 4).map(function(t) {
            return '<span class="theme-chip">' + escapeHtml(String(t)) + '</span>';
          }).join('') +
          '</div>';
      }

      item.innerHTML =
        '<div class="session-item-header">' +
          '<span class="session-item-date">' + escapeHtml(dateStr) + '</span>' +
          pillarBadge +
        '</div>' +
        (session.title
          ? '<p class="session-title-text">' + escapeHtml(session.title) + '</p>'
          : '') +
        '<p class="session-summary-text">' + escapeHtml(session.summary || 'No summary recorded.') + '</p>' +
        (msgCount ? '<p class="session-msg-count">' + session.message_count + ' messages</p>' : '') +
        topicsHtml;

      container.appendChild(item);
    });

  } catch (e) {
    console.error('[sidebar] loadSessionHistory error:', e?.message || e);
    container.innerHTML =
      '<div class="sidebar-empty">Couldn\u2019t load session history. Please try again.</div>';
  }
}

// ─── ADKAR ─────────────────────────────────────────────────────────────────
function setScore(stage, score) {
  adkarScores[stage] = score;
  document.querySelectorAll(`#scale-${stage} button`).forEach((btn, i) => {
    btn.classList.toggle('selected', i + 1 === score);
  });
}
async function submitAdkar() {
  const required = ['awareness','desire','knowledge','ability','reinforcement'];
  const missing  = required.filter(s => !adkarScores[s]);
  if (missing.length > 0) {
    document.getElementById(`scale-${missing[0]}`).scrollIntoView({ behavior: 'smooth' });
    return;
  }
  const changeContext = document.getElementById('adkar-context-select').value;
  try {
    await saveAdkarScores(currentUser.id, adkarScores, changeContext);
  } catch (e) {
    logSignupError('adkar_submit', {
      message:  e?.message,
      code:     e?.code,
      email:    currentUser?.email,
      metadata: { change_context: changeContext }
    });
  }
  showScreen('chat-screen');
}
function skipAdkar() { showScreen('chat-screen'); }

// ─── Chat ──────────────────────────────────────────────────────────────────
async function handleSend() {
  const input   = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  input.style.height = 'auto';
  document.getElementById('send-btn').disabled = true;

  addMessage('user', message);
  showTyping(true);

  const response = await sendMessage(message);

  showTyping(false);

  // Empty string is the sentinel from coaching.js when trial has expired.
  if (!response) return;

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
  // Phase H: removed confirm() dialog — one click ends the session directly.
  closeSidebar();
  await endSession(currentUser.id);
  adkarScores = {};
  document.getElementById('messages').innerHTML =
    `<div class="welcome-msg"><strong>Session saved.</strong> Your progress has been noted. Come back whenever you need.</div>`;
  if (typeof resetSessionPromptCount === 'function') resetSessionPromptCount();
  if (typeof resetConversationHistory === 'function') resetConversationHistory();
  showScreen('adkar-screen');
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
  const messages  = document.getElementById('messages');
  const welcome   = messages.querySelector('.welcome-msg');
  if (welcome) welcome.remove();
  const div       = document.createElement('div');
  div.className   = `message ${role}`;
  const time      = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const safeContent = role === 'user' ? escapeHtml(content) : formatCoachText(content);
  div.innerHTML   = `<div class="message-bubble">${safeContent}</div><div class="message-time">${time}</div>`;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}
function showTyping(visible) {
  document.getElementById('typing').classList.toggle('visible', visible);
  document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
}
function showScreen(id) {
  document.documentElement.classList.remove('auth-callback');
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
