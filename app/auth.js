// ─── Supabase client ────────────────────────────────────────────────
// Using backticks (not single quotes) so macOS smart-quote substitution
// can't break JS parsing if this file is ever pasted vs. uploaded.
const SUPABASE_URL = `https://ylufotpafbmhhjffovpf.supabase.co`;
const SUPABASE_ANON_KEY = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlsdWZvdHBhZmJtaGhqZmZvdnBmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU0NDI1OTMsImV4cCI6MjA5MTAxODU5M30.biYCZXpP_7k5iBTGTWoZc7gA3cY6IlKTTRUP3ZXLppU`;

const { createClient } = supabase;
const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function getSession() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  return session;
}
async function getUser() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  return user;
}

// ─── Magic Link Auth ───────────────────────────────────────────────
// preferredName now flows through options.data → auth.users.raw_user_meta_data
// so it survives cross-device magic-link clicks (user types name on laptop,
// clicks link on phone → name is still on the account). The server-side
// handle_new_user trigger reads this into user_profiles.preferred_name.
async function sendMagicLink(email, preferredName) {
  const options = {
    shouldCreateUser: true,
    emailRedirectTo: window.location.origin + window.location.pathname,
  };
  if (preferredName && preferredName.trim()) {
    options.data = { preferred_name: preferredName.trim() };
  }
  const { error } = await supabaseClient.auth.signInWithOtp({ email, options });
  if (error) throw error;
}

// ─── Legacy password auth (kept for backward compatibility, not actively used) ─
async function signUp(email, password, preferredName) {
  const { data, error } = await supabaseClient.auth.signUp({
    email, password, options: { data: { preferred_name: preferredName } }
  });
  if (error) throw error;
  // user_profiles row is now created server-side by the on_auth_user_created trigger.
  // No client-side insert needed.
  return data;
}
async function signIn(email, password) {
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

async function signOut() {
  const { error } = await supabaseClient.auth.signOut();
  if (error) throw error;
}
function onAuthStateChange(callback) {
  return supabaseClient.auth.onAuthStateChange(callback);
}

// ─── Corporate Email Detection ─────────────────────────────────────
const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'yahoo.com', 'yahoo.co.uk', 'yahoo.ca', 'yahoo.com.au',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'sbcglobal.net', 'att.net', 'bellsouth.net', 'comcast.net',
  'protonmail.com', 'proton.me', 'pm.me',
  'zoho.com', 'zohomail.com',
  'fastmail.com',
  'tutanota.com', 'tuta.io',
  'yandex.com', 'yandex.ru',
  'mail.com', 'email.com',
  'gmx.com', 'gmx.net',
  'hey.com', 'duck.com',
  'mailbox.org', 'posteo.de', 'posteo.net',
]);

function isPersonalEmail(email) {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return true; // don't fail on incomplete input
  return PERSONAL_DOMAINS.has(domain);
}

// ─── Error Observability (DB-based) ────────────────────────────────
// Writes to public.signup_errors. Silent on failure — never blocks user flow.
// Allowed error_stage values (enforced by RLS policy):
//   'magic_link_send' | 'post_auth_upsert' | 'signup_code_redeem'
//   | 'confirmation_callback' | 'session_start' | 'adkar_submit'
//   | 'message_send' | 'work_email_blocked' | 'unknown'
async function logSignupError(stage, params = {}) {
  try {
    let userId = null;
    try {
      const { data: { user } } = await supabaseClient.auth.getUser();
      userId = user?.id || null;
    } catch (_) { /* pre-auth is fine */ }

    const row = {
      error_stage: stage,
      error_code: params.code ? String(params.code).slice(0, 200) : null,
      error_message: params.message ? String(params.message).slice(0, 2000) : null,
      email_attempted: params.email ? String(params.email).slice(0, 320) : null,
      user_id: userId,
      user_agent: (navigator.userAgent || '').slice(0, 1000),
      url: (window.location.href || '').slice(0, 2000),
      metadata: params.metadata || null,
    };
    await supabaseClient.from('signup_errors').insert(row);
  } catch (e) {
    // Never let observability failures propagate.
    console.warn('[signup_errors] could not log:', e?.message || e);
  }
}

// ─── Supabase error → friendly message mapping ─────────────────────
// Given a thrown error, return { friendly, code, isRateLimit }.
function classifyAuthError(err) {
  const raw = (err?.message || '').toLowerCase();
  const code = err?.code || err?.status || null;

  // Rate limit: message usually contains "rate limit" or "only request after N seconds"
  if (raw.includes('rate limit') || raw.includes('only request') || raw.includes('security purposes')) {
    return {
      code: 'email_rate_limit_exceeded',
      isRateLimit: true,
      friendly: "We've sent a few links to this address already. Give it a minute, check your spam folder, and the latest one should arrive shortly."
    };
  }
  if (raw.includes('invalid') && raw.includes('email')) {
    return { code: 'invalid_email', isRateLimit: false,
             friendly: "That doesn't look like a valid email address. Double-check and try again." };
  }
  if (raw.includes('unable to validate')) {
    return { code: 'unable_to_validate_email', isRateLimit: false,
             friendly: "We couldn't validate that email. Please check the address and try again." };
  }
  // Default
  return {
    code: code || 'unknown',
    isRateLimit: false,
    friendly: "Something went wrong sending your login link. Please try again in a moment."
  };
}
