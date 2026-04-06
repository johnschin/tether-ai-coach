// App initializes after all scripts load
window.addEventListener('DOMContentLoaded', async () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(console.error);
  }
  const session = await getSession();
  if (session?.user) {
    currentUser = session.user;
    await startUserSession();
  }
});
