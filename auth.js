const SUPABASE_URL = 'https://ylufotpafbmhhjffovpf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlsdWZvdHBhZmJtaGhqZmZvdnBmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU0NDI1OTMsImV4cCI6MjA5MTAxODU5M30.biYCZXpP_7k5iBTGTWoZc7gA3cY6IlKTTRUP3ZXLppU';
const { createClient } = supabase;
const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    flowType: 'implicit',
    detectSessionInUrl: true,
  }
});

async function getSession() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  return session;
}
async function getUser() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  return user;
}

// ─── Magic Link Auth ───────────────────────────────────────────────
async function sendMagicLink(email) {
  const { error } = await supabaseClient.auth.signInWithOtp({
    email: email,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: window.location.origin + window.location.pathname,
    }
  });
  if (error) throw error;
}

// ─── Legacy password auth (kept for backward compatibility) ────────
async function signUp(email, password, preferredName) {
  const { data, error } = await supabaseClient.auth.signUp({
    email, password, options: { data: { preferred_name: preferredName } }
  });
  if (error) throw error;
  if (data.user) {
    await supabaseClient.from('user_profiles').insert({ id: data.user.id, preferred_name: preferredName });
  }
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
  if (!domain) return true;
  return PERSONAL_DOMAINS.has(domain);
}
