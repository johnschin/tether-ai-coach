const SUPABASE_URL = 'https://ylufotpafbmhhjffovpf.supabase.co';
const SUPABASE_ANON_KEY = 'REPLACE_WITH_YOUR_ANON_KEY';
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
