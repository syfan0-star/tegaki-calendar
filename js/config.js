// App-wide constants for the Google integration.
//
// GOOGLE_CLIENT_ID is the Web client of the Google Cloud project 'tegaki-calendar' (docs/SETUP.md).
// A client ID is public by design (it is sent in every sign-in URL); the client secret is never used.

export const APP_VERSION = '1.0.4';

/** OAuth 2.0 Web client ID ('xxxx.apps.googleusercontent.com'); '' → Google features disabled. */
export const GOOGLE_CLIENT_ID = '114879404947-dsm25vst22i9gvj1kkg418nb4n74miiv.apps.googleusercontent.com';

/** OAuth scopes, requested together in one consent (granular consent may drop some of them). */
export const SCOPES = Object.freeze({
  events: 'https://www.googleapis.com/auth/calendar.events',
  calList: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  appdata: 'https://www.googleapis.com/auth/drive.appdata',
});

/**
 * Production URL; also the exact Authorized redirect URI registered for GitHub Pages (trailing '/').
 *
 * SECURITY: every GitHub Pages project site of this account shares the ORIGIN https://syfan0-star.github.io,
 * and with it localStorage ('tegaki.auth.token' = a Calendar/Drive bearer token) and the 'tegaki-calendar'
 * IndexedDB (all handwriting). Never publish another Pages project under syfan0-star.github.io while the app
 * lives here (docs/SETUP.md). Moving to a dedicated origin (custom domain, or a user-site repo used only for
 * this app) means changing this constant, the manifest scope and the registered redirect URI / JS origin —
 * and ink not yet uploaded to Drive stays behind in the old origin, so decide it before daily use.
 */
export const PAGES_ORIGIN_PATH = 'https://syfan0-star.github.io/tegaki-calendar/';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * The redirect URI EXACTLY as registered in Google Cloud Console.
 * Chosen by hostname only — never derived from location.href (index.html, query strings or a missing
 * trailing slash would cause redirect_uri_mismatch).
 *   localhost / 127.0.0.1 → `${origin}/`   (e.g. 'http://localhost:8000/')
 *   anything else          → PAGES_ORIGIN_PATH
 * @param {{ hostname?: string, origin?: string, protocol?: string, host?: string }} [loc]
 * @returns {string}
 */
export function redirectUri(loc = globalThis.location) {
  const hostname = loc && typeof loc.hostname === 'string' ? loc.hostname : '';
  if (LOCAL_HOSTS.has(hostname)) {
    const origin = typeof loc.origin === 'string' && loc.origin && loc.origin !== 'null'
      ? loc.origin
      : `${loc.protocol || 'http:'}//${loc.host || hostname}`;
    return `${origin}/`;
  }
  return PAGES_ORIGIN_PATH;
}

/**
 * True when a real OAuth client ID has been filled in.
 * @param {string} [clientId] defaults to GOOGLE_CLIENT_ID (parameter exists for tests)
 */
export function isGoogleConfigured(clientId = GOOGLE_CLIENT_ID) {
  return typeof clientId === 'string'
    && clientId.length > '.apps.googleusercontent.com'.length
    && clientId.endsWith('.apps.googleusercontent.com');
}
