/**
 * Resume-after-reload — sessionStorage-backed pending sign-in handoff.
 *
 * The install upsell modal handles the common case where the user
 * installs MATA in a new tab and returns to the RP tab — the modal's
 * polling detects `window.__mata_mid__` and the in-flight `signIn()`
 * promise resolves. But there's a second path: the user reloads the
 * RP tab manually (or Chrome's "Extension installed" toast nudges them
 * to). In that path the modal is gone and the awaiting promise dies.
 *
 * This module persists enough state across the reload that
 * `resumePendingSignIn()` can pick the flow back up the moment the
 * page boots.
 *
 * ## Storage model
 *
 * - **sessionStorage**, not localStorage. Per-tab, cleared on tab
 *   close. Matches the natural lifespan of a sign-in request — we
 *   don't want a stale resume to fire 3 days later in a different
 *   browsing session.
 * - **One pending entry per tab.** If `signIn()` is called twice
 *   before the first resolves, the second overwrites — same UX as the
 *   modal-replacement behavior in the consent handoff.
 * - **TTL = the original request's `timeoutMs`**. If the user reloads
 *   after the request would have timed out anyway, the resume entry
 *   is treated as stale and dropped.
 *
 * ## When the entry is cleared
 *
 * - On successful resolution (JWT received).
 * - On user cancel from the upsell modal.
 * - On TTL expiry at the next `resumePendingSignIn()` call.
 * - On any non-`ERR_NO_WALLET_INSTALLED` error from `signIn()` (so
 *   resume doesn't keep retrying a malformed request).
 */

/** Fixed sessionStorage key. One pending sign-in per tab. */
const STORAGE_KEY = 'mata_mid_pending_signin';

/**
 * Stash a pending sign-in for possible resume after page reload.
 *
 * @param {object} entry
 * @param {object} entry.request - the original `SignInRequest` shape.
 * @param {object} entry.options - the original `SignInOptions` shape.
 * @param {number} entry.expiresAt - Unix ms; entries past this time
 *     are treated as stale.
 */
export function stashPendingSignIn(entry) {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entry));
  } catch (_) {
    // Storage quota / private-mode rejection — silent skip is fine;
    // the only consequence is that reload-resume won't fire.
  }
}

/**
 * Read the pending sign-in entry. Returns `null` when there isn't one,
 * when it's malformed, or when the TTL has passed (in which case the
 * entry is also cleared).
 *
 * @returns {{request: object, options: object, expiresAt: number} | null}
 */
export function readPendingSignIn() {
  if (typeof sessionStorage === 'undefined') return null;
  let raw;
  try {
    raw = sessionStorage.getItem(STORAGE_KEY);
  } catch (_) {
    return null;
  }
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    clearPendingSignIn();
    return null;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof parsed.request !== 'object' ||
    typeof parsed.expiresAt !== 'number'
  ) {
    clearPendingSignIn();
    return null;
  }
  if (Date.now() >= parsed.expiresAt) {
    clearPendingSignIn();
    return null;
  }
  // `options` is optional — older entries from a partial-deploy may
  // omit it. Treat missing as `{}` so the resume call still composes.
  if (typeof parsed.options !== 'object' || parsed.options === null) {
    parsed.options = {};
  }
  return parsed;
}

/**
 * Clear any pending sign-in entry. Safe to call when nothing is
 * pending.
 */
export function clearPendingSignIn() {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch (_) {
    /* best-effort */
  }
}
