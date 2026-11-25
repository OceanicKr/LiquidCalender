// Google sign-in via chrome.identity.launchWebAuthFlow. This works in Brave,
// Chrome and Edge (getAuthToken only works in Chrome). It uses the token flow,
// so there's no client secret: tokens last about an hour and get renewed
// quietly (prompt=none) while you're still signed in to Google.
//
// Everyone uses their own OAuth client ID. It's pasted in on the Connect
// screen and kept in chrome.storage, so nothing personal lives in the code.

export async function getClientId() {
  const { clientId } = await chrome.storage.local.get("clientId");
  return (clientId || "").trim();
}

export async function setClientId(id) {
  await chrome.storage.local.set({ clientId: id.trim() });
  await chrome.storage.local.remove("auth"); // a token from another client is useless
}

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly", // calendar list + colors
  "https://www.googleapis.com/auth/calendar.events",   // create / edit / delete
  "https://www.googleapis.com/auth/tasks",             // Google Tasks: read / tick off / edit
].join(" ");

export class AuthError extends Error {}

export async function getToken({ interactive = false } = {}) {
  const { auth } = await chrome.storage.local.get("auth");
  // A token from before a scope was added (e.g. Tasks) is treated as missing, so you get asked again.
  if (auth && auth.scope === SCOPES && auth.expires > Date.now() + 60_000) return auth.token;
  return authorize(interactive);
}

export async function clearToken() {
  await chrome.storage.local.remove("auth");
}

async function authorize(interactive) {
  const clientId = await getClientId();
  if (!clientId) {
    if (!interactive) return null;
    throw new Error("Paste your Google OAuth client ID first");
  }
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: "token",
    redirect_uri: chrome.identity.getRedirectURL(), // https://<ext-id>.chromiumapp.org/
    scope: SCOPES,
    include_granted_scopes: "true",
    ...(interactive ? { prompt: "select_account" } : { prompt: "none" }),
  });

  let redirect;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({
      url: url.href,
      interactive,
      ...(interactive ? {} : { abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 8000 }),
    });
  } catch (err) {
    if (!interactive) return null; // silent renew failed -> show "Connect" button
    throw err;
  }

  const params = new URLSearchParams(new URL(redirect).hash.slice(1));
  if (params.get("error")) {
    if (!interactive) return null;
    throw new Error(params.get("error"));
  }
  const token = params.get("access_token");
  const expires = Date.now() + Number(params.get("expires_in") || 3600) * 1000;
  await chrome.storage.local.set({ auth: { token, expires, scope: SCOPES } });
  return token;
}

export async function signOut() {
  const { auth } = await chrome.storage.local.get("auth");
  await clearToken();
  if (auth?.token) {
    fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: auth.token }),
    }).catch(() => {});
  }
}
