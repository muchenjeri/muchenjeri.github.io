// Google sign-in with Google Identity Services (token model). Browsers get one-hour access tokens
// and no refresh token, so after a token expires a click on "Sign in to sync" gets a new one
// (usually without any prompt). Writing never depends on this: entries are saved locally first.
import { CLIENT_ID } from './config.js';
import { AuthRequiredError } from './engine.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.appdata email';
const KEY = 'mj-auth';

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Couldn't load Google sign-in (are you offline?)"));
    document.head.appendChild(s);
  });
}

export class GoogleAuth {
  constructor() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { /* ignore */ }
    this.email = saved.email ?? null;       // null = not connected
    this.connected = !!saved.connected;
    this.token = saved.token ?? null;
    this.expiresAt = saved.expiresAt ?? 0;
    this.listeners = new Set();
  }

  onChange(fn) { this.listeners.add(fn); }
  #save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ connected: this.connected, email: this.email, token: this.token, expiresAt: this.expiresAt }));
    } catch { /* storage unavailable: stays in memory */ }
    for (const fn of this.listeners) fn();
  }

  get hasValidToken() { return !!this.token && Date.now() < this.expiresAt - 60_000; }

  /** Must be called from a click (it may open a Google popup). */
  async signIn() {
    if (!CLIENT_ID || CLIENT_ID.startsWith('PASTE')) throw new Error('The web OAuth client ID is not set in js/config.js');
    await loadGis();
    const resp = await new Promise((resolve, reject) => {
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPE,
        callback: (r) => (r.error ? reject(new Error(r.error_description || r.error)) : resolve(r)),
        error_callback: (e) => reject(new Error(e.message || e.type || 'Sign-in was cancelled')),
      });
      client.requestAccessToken({ prompt: this.connected ? '' : 'consent', hint: this.email ?? undefined });
    });
    if (!window.google.accounts.oauth2.hasGrantedAllScopes(resp, 'https://www.googleapis.com/auth/drive.appdata')) {
      throw new Error('Google Drive access was not granted');
    }
    this.token = resp.access_token;
    this.expiresAt = Date.now() + Number(resp.expires_in ?? 3600) * 1000;
    this.connected = true;
    if (!this.email) {
      try {
        const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${this.token}` } });
        if (r.ok) this.email = (await r.json()).email ?? null;
      } catch { /* not essential */ }
    }
    this.#save();
  }

  async getToken() {
    if (this.hasValidToken) return this.token;
    throw new AuthRequiredError();
  }

  invalidate(bad) {
    if (this.token === bad) { this.token = null; this.expiresAt = 0; this.#save(); }
  }

  /** Forgets the account on this browser. Entries stay in this browser and on Drive. */
  signOut() {
    this.connected = false;
    this.email = null;
    this.token = null;
    this.expiresAt = 0;
    this.#save();
  }
}
