/**
 * @matanetwork/sovereign-id — page-side SDK for MATA's permissionless self-
 * issued identity protocol (mID).
 *
 * Phase 5 of the mID Mission. This package is what relying parties
 * (RPs) `npm install` and call from their sign-in button. It:
 *
 *  1. Probes for the MATA browser extension via `window.__mata_mid__`.
 *  2. Falls back to deep-linking the MATA native app via
 *     `mata-mid://request?payload=...` if no extension is found.
 *  3. Surfaces an install prompt if neither is available.
 *
 * The wire protocol the SDK speaks (page ↔ content-script / native
 * app) is locked by ADR 0005 Decision 2/3 — see the Rust
 * `mid-consent-types` crate for the canonical types this package
 * mirrors.
 */

// ─── Wire protocol constants (ADR 0005 Decision 2/3) ────────────────────────

/**
 * The JavaScript global the extension's content script injects on every
 * page. The SDK probes for this presence to detect the extension.
 * @internal
 */
export const WINDOW_MID_GLOBAL = '__mata_mid__';

/**
 * The discriminator key on every page ↔ content-script postMessage.
 * Lets the SDK filter `window.postMessage` events cheaply.
 * @internal
 */
export const MESSAGE_DISCRIMINATOR = '__mata_mid_v1';

/** The `kind` value on the sign-in request message. @internal */
export const KIND_SIGN_IN_REQUEST = 'sign_in_request';

/** The `kind` value on the sign-in response message. @internal */
export const KIND_SIGN_IN_RESPONSE = 'sign_in_response';

/** The `kind` value on the IAMHUMAN statement-sign request message. @internal */
export const KIND_STATEMENT_SIGN_REQUEST = 'statement_sign_request';

/** The `kind` value on the IAMHUMAN statement-sign response message. @internal */
export const KIND_STATEMENT_SIGN_RESPONSE = 'statement_sign_response';

/** The native app's URL scheme. @internal */
export const URL_SCHEME = 'mata-mid';

/** The path under the URL scheme. @internal */
export const SCHEME_PATH_REQUEST = 'request';

/** The query parameter that carries the base64url-encoded payload. @internal */
export const QUERY_PARAM_PAYLOAD = 'payload';

/**
 * The URL-fragment key in the response callback that carries the
 * base64url-encoded response.
 * @internal
 */
export const FRAGMENT_KEY_RESPONSE = 'mid_response';

/** Native protocol version. Pinned at 1 per ADR. @internal */
export const PROTOCOL_VERSION = 1;

// ─── Standard error codes ──────────────────────────────────────────────────

export const ERR_USER_DENIED = 'user_denied';
export const ERR_ORIGIN_MISMATCH = 'origin_mismatch';
export const ERR_INVALID_REQUEST = 'invalid_request';
export const ERR_WALLET_UNAVAILABLE = 'wallet_unavailable';
export const ERR_REQUIRED_CLAIM_UNAVAILABLE = 'required_claim_unavailable';
export const ERR_INTERNAL = 'internal_error';
export const ERR_NO_WALLET_INSTALLED = 'no_wallet_installed';
export const ERR_TIMEOUT = 'timeout';
/**
 * The user dismissed the install upsell ("Cancel" or Escape).
 * Distinct from `user_denied` (the user reached the consent screen
 * and denied disclosure). RPs typically render the same UI for both,
 * but the distinct code lets analytics separate "didn't install" from
 * "installed but said no."
 */
export const ERR_UPSELL_CANCELED = 'upsell_canceled';

// ─── SignInError class ─────────────────────────────────────────────────────

/**
 * Error thrown by `signIn()` on any failure path. The `code` is one of
 * the `ERR_*` constants exported above; the RP's catch block can
 * branch on it.
 */
export class SignInError extends Error {
  /**
   * @param {string} code - one of the `ERR_*` constants
   * @param {string} message - human-readable detail
   */
  constructor(code, message) {
    super(message);
    this.name = 'SignInError';
    /** @type {string} */
    this.code = code;
  }
}

// ─── signIn() — the main API ───────────────────────────────────────────────

import {
  stashPendingSignIn,
  readPendingSignIn,
  clearPendingSignIn,
} from './resume.js';

/**
 * Default token request timeout: 2 minutes. The user has this long to
 * approve or deny the consent screen before the SDK rejects.
 */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Request a sign-in from the user's MATA wallet.
 *
 * @param {object} request
 * @param {string} request.rpOrigin - RP's bare origin, e.g. "https://acme.com"
 * @param {string} request.nonce - RP-issued single-use nonce
 * @param {object} request.claims - claim catalog
 * @param {string[]} request.claims.required - required claim keys
 * @param {string[]} [request.claims.optional] - optional claim keys
 * @param {Record<string, {optional: true, description?: string}>} [request.claims.custom] - custom claims
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - request timeout (default: 2 min)
 * @param {string} [options.nativeAppCallback] - URL the native app opens to return (default: window.location.href). For a native host, set this to your app's own custom scheme (e.g. `"myapp://mid-callback"`) so the wallet's callback routes back to your app rather than a browser tab.
 * @param {boolean} [options.nativeHost] - set `true` when this SDK runs inside a native webview (Dioxus/Tauri/wry/Electron) rather than a real browser tab. Skips the browser-only "no wallet" visibility heuristic (which would false-positive because a native webview never backgrounds) and relies on the hard `timeoutMs` instead. Pair with `nativeAppCallback` + your host injecting the `#mid_response` fragment back into the webview.
 * @param {boolean} [options.installUpsell] - whether to show the install upsell when no wallet is detected (default: true). Set to false to get the raw `ERR_NO_WALLET_INSTALLED` error and handle the upsell UI yourself.
 * @param {string | null} [options.ref] - referral code attributed to signups that flow through the install upsell. Defaults to the hostname extracted from `rpOrigin` (e.g., `"acme.com"`) so RPs get attribution by default. Pass `null` to opt out, or a custom string to override (e.g., a configured MATA referral code). Follows the existing `?ref=` convention captured by my.mata.network's signup flow.
 * @returns {Promise<{jwt: string, surface: "extension" | "native_app"}>}
 * @throws {SignInError} with `.code` matching one of the `ERR_*` constants
 */
export async function signIn(request, options = {}) {
  validateRequest(request);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const upsellEnabled = options.installUpsell !== false;

  if (hasExtension()) {
    // A direct extension path supersedes any stashed resume entry —
    // the user is no longer waiting on the install upsell. Clear so
    // a later `resumePendingSignIn()` call doesn't re-fire this
    // same request.
    clearPendingSignIn();
    return await signInViaExtension(request, timeoutMs);
  }

  // Extension not present — try native app surface. If that also
  // can't find a wallet AND the RP opted into the install upsell, run
  // the upsell and retry signIn on success.
  try {
    const result = await signInViaNativeApp(request, options, timeoutMs);
    clearPendingSignIn();
    return result;
  } catch (err) {
    if (
      upsellEnabled &&
      err instanceof SignInError &&
      err.code === ERR_NO_WALLET_INSTALLED
    ) {
      return await runInstallUpsellAndRetry(request, options, timeoutMs);
    }
    // Any other error means the request itself was bad — purge the
    // stash so the next reload doesn't pointlessly re-attempt a
    // request that's structurally broken (malformed nonce, denied,
    // etc.). Network-flake retries are the RP's job.
    clearPendingSignIn();
    throw err;
  }
}

/**
 * Run the install upsell modal. On `"installed"`, retry signIn (the
 * extension is now present, so the retry hits the extension surface).
 * On `"canceled"`, throw `ERR_UPSELL_CANCELED`.
 *
 * Before opening the modal, stash a resume entry in sessionStorage so
 * that a manual page reload (or Chrome's "extension installed" toast
 * nudging the user) doesn't lose the in-flight request. See
 * [`resume.js`](./resume.js) for the storage model.
 *
 * @internal
 */
async function runInstallUpsellAndRetry(request, options, timeoutMs) {
  // Lazy import so RPs who opt out of the upsell don't pay the bundle
  // cost. Bundlers (Webpack/Vite/esbuild) tree-shake this when
  // `installUpsell: false` is the only call site.
  const { showInstallUpsell } = await import('./install-upsell.js');

  // Stash for resume-after-reload. `options` may carry `installUpsell:
  // false` from a self-retry path; strip it when stashing so the
  // resumed signIn doesn't skip the upsell entirely.
  stashPendingSignIn({
    request,
    options: { ...options, installUpsell: undefined },
    expiresAt: Date.now() + timeoutMs,
  });

  let result;
  try {
    result = await showInstallUpsell({
      rpOrigin: request.rpOrigin,
      hasExtensionFn: hasExtension,
      // Thread the RP's explicit ref through. `undefined` (i.e. RP
      // didn't set the option) leaves the upsell to auto-derive from
      // rpOrigin; `null` opts the RP out of attribution entirely.
      ref: options.ref,
    });
  } catch (e) {
    clearPendingSignIn();
    throw e;
  }

  if (result === 'installed') {
    clearPendingSignIn();
    if (hasExtension()) {
      return await signInViaExtension(request, timeoutMs);
    }
    // Race — extension was detected by the modal's poll but is now
    // gone (uninstall? content-script crash?). Fall through to the
    // native attempt with upsell disabled to avoid infinite-modal.
    return await signInViaNativeApp(request, { ...options, installUpsell: false }, timeoutMs);
  }
  clearPendingSignIn();
  throw new SignInError(
    ERR_UPSELL_CANCELED,
    'user dismissed the install upsell'
  );
}

/**
 * Resume a sign-in that was interrupted by a page reload during the
 * install upsell.
 *
 * Call this once on page boot — ideally as early as possible in your
 * app's startup so the user sees the sign-in continue without a
 * visible flicker through your logged-out state.
 *
 * Returns:
 *
 * - `{jwt, surface}` — a pending request was found, the extension is
 *   now installed, and the resumed sign-in succeeded.
 * - `null` — no pending request was stashed, or the stash is stale,
 *   or the extension is still not installed (the user reloaded
 *   before completing the install).
 *
 * Rejects with a `SignInError` if a pending request exists AND the
 * extension is present but the sign-in itself failed (user denied,
 * timeout, etc.) — same error shape as `signIn()`.
 *
 * Typical usage:
 *
 * ```js
 * import { resumePendingSignIn } from '@matanetwork/sovereign-id';
 *
 * resumePendingSignIn().then((result) => {
 *   if (result) {
 *     // user installed the extension and the sign-in completed.
 *     handleSignedIn(result.jwt);
 *   }
 *   // else: no pending request, the boot path proceeds normally.
 * });
 * ```
 *
 * @returns {Promise<SignInSuccess | null>}
 */
export async function resumePendingSignIn() {
  const pending = readPendingSignIn();
  if (!pending) return null;

  // Extension still not installed → keep the stash in place so a
  // follow-up reload (after the user finally installs) still resumes.
  // Returning null lets the RP's normal boot flow continue rendering
  // the sign-in button.
  if (!hasExtension()) return null;

  // Compute the residual timeout — total budget minus the elapsed
  // wall-clock since the original signIn(). Floor at 1s so a very
  // late reload still gets a real try at the extension surface.
  const remainingMs = Math.max(1_000, pending.expiresAt - Date.now());

  clearPendingSignIn();
  try {
    return await signInViaExtension(pending.request, remainingMs);
  } catch (e) {
    // Surface the error to the RP — they decide whether to show the
    // sign-in button again, surface "your previous attempt timed
    // out," etc.
    throw e;
  }
}

/**
 * Whether the MATA browser extension is installed on this page.
 *
 * @returns {boolean}
 */
export function hasExtension() {
  return (
    typeof window !== 'undefined' &&
    typeof window[WINDOW_MID_GLOBAL] === 'object' &&
    window[WINDOW_MID_GLOBAL] !== null &&
    window[WINDOW_MID_GLOBAL].version === PROTOCOL_VERSION
  );
}

/**
 * Validate the request shape. Throws SignInError with code
 * `invalid_request` if anything is off.
 *
 * @internal
 * @param {object} request
 */
function validateRequest(request) {
  if (typeof request !== 'object' || request === null) {
    throw new SignInError(ERR_INVALID_REQUEST, 'request must be an object');
  }
  if (typeof request.rpOrigin !== 'string' || request.rpOrigin.length === 0) {
    throw new SignInError(ERR_INVALID_REQUEST, 'rpOrigin must be a non-empty string');
  }
  if (typeof request.nonce !== 'string' || request.nonce.length === 0) {
    throw new SignInError(ERR_INVALID_REQUEST, 'nonce must be a non-empty string');
  }
  if (typeof request.claims !== 'object' || request.claims === null) {
    throw new SignInError(ERR_INVALID_REQUEST, 'claims must be an object');
  }
  if (!Array.isArray(request.claims.required)) {
    throw new SignInError(
      ERR_INVALID_REQUEST,
      'claims.required must be an array (use [] if no required claims)'
    );
  }
}

// ─── Extension surface ─────────────────────────────────────────────────────

/**
 * Send the sign-in request via the extension's `window.postMessage`
 * channel, wait for the response.
 *
 * @internal
 * @param {object} request
 * @param {number} timeoutMs
 * @returns {Promise<{jwt: string, surface: "extension"}>}
 */
function signInViaExtension(request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const requestId = generateRequestId();
    let timeoutHandle = null;

    const messageHandler = (event) => {
      const data = event.data;
      if (typeof data !== 'object' || data === null) return;
      if (data[MESSAGE_DISCRIMINATOR] !== true) return;
      if (data.kind !== KIND_SIGN_IN_RESPONSE) return;
      if (data.request_id !== requestId) return;

      // It's our response.
      window.removeEventListener('message', messageHandler);
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);

      const result = data.result;
      if (typeof result !== 'object' || result === null) {
        reject(new SignInError(ERR_INTERNAL, 'malformed response from wallet'));
        return;
      }
      if (result.outcome === 'ok') {
        resolve({ jwt: result.jwt, surface: 'extension' });
      } else if (result.outcome === 'denied') {
        reject(new SignInError(ERR_USER_DENIED, 'user denied disclosure'));
      } else if (result.outcome === 'error') {
        reject(new SignInError(result.error_code ?? ERR_INTERNAL, result.message ?? ''));
      } else {
        reject(new SignInError(ERR_INTERNAL, `unknown outcome: ${result.outcome}`));
      }
    };

    window.addEventListener('message', messageHandler);

    // Send the request.
    const payload = {
      [MESSAGE_DISCRIMINATOR]: true,
      kind: KIND_SIGN_IN_REQUEST,
      request_id: requestId,
      rp_origin: request.rpOrigin,
      nonce: request.nonce,
      claims: {
        required: request.claims.required,
        optional: request.claims.optional ?? [],
        custom: request.claims.custom ?? {},
      },
    };
    window.postMessage(payload, '*');

    // Timeout fallback.
    timeoutHandle = setTimeout(() => {
      window.removeEventListener('message', messageHandler);
      reject(new SignInError(ERR_TIMEOUT, `no response within ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

// ─── signStatement() — IAMHUMAN content signing (H0-broker) ─────────────────

/**
 * Ask the user's MATA wallet to sign content as their personal DID (an
 * IAMHUMAN post/comment). The private key never leaves the wallet — it signs
 * and returns a self-contained `mata-sign` token that the IAMHUMAN host
 * accepts as-is. Parallel to `signIn()`, but produces a content signature.
 *
 * Extension surface only for now; native `mata-mid://statement` is a follow-up.
 *
 * @param {object} request
 * @param {string} request.rpOrigin - the requesting site's bare origin
 * @param {string} request.content - the exact content to sign
 * @param {string} request.context - domain tag, e.g. "iamhuman"
 * @param {string} [request.contentType] - media type (default "text/plain")
 * @param {string | null} [request.nonce] - optional single-use nonce
 * @param {"every-time"} [request.consent] - `"every-time"` makes the wallet
 *   ask for this one signature and never remember the approval (for
 *   statements that hand something over, like a device adoption). Omitted,
 *   the wallet may reuse a standing grant for (origin, context). Wallets
 *   that honour it set `window.__mata_mid__.statementConsentEveryTime`.
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - request timeout (default 2 min)
 * @returns {Promise<{token: string, surface: "extension"}>}
 * @throws {SignInError} with `.code` matching one of the `ERR_*` constants
 */
export async function signStatement(request, options = {}) {
  if (
    !request ||
    typeof request.rpOrigin !== 'string' ||
    typeof request.content !== 'string' ||
    typeof request.context !== 'string'
  ) {
    throw new SignInError(
      ERR_INVALID_REQUEST,
      'signStatement requires { rpOrigin, content, context }',
    );
  }
  if (request.consent !== undefined && request.consent !== 'every-time') {
    throw new SignInError(
      ERR_INVALID_REQUEST,
      'signStatement consent must be "every-time" when given',
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (hasExtension()) {
    return await signStatementViaExtension(request, timeoutMs);
  }
  throw new SignInError(
    ERR_NO_WALLET_INSTALLED,
    'MATA extension not detected (native statement signing is a follow-up)',
  );
}

/**
 * Send the statement-sign request via the extension's `window.postMessage`
 * bridge and await the wallet's response.
 * @internal
 */
function signStatementViaExtension(request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const requestId = generateRequestId();
    let timeoutHandle = null;

    const messageHandler = (event) => {
      const data = event.data;
      if (typeof data !== 'object' || data === null) return;
      if (data[MESSAGE_DISCRIMINATOR] !== true) return;
      if (data.kind !== KIND_STATEMENT_SIGN_RESPONSE) return;
      if (data.request_id !== requestId) return;

      window.removeEventListener('message', messageHandler);
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);

      const result = data.result;
      if (typeof result !== 'object' || result === null) {
        reject(new SignInError(ERR_INTERNAL, 'malformed response from wallet'));
        return;
      }
      if (result.outcome === 'ok') {
        resolve({ token: result.token, surface: 'extension' });
      } else if (result.outcome === 'denied') {
        reject(new SignInError(ERR_USER_DENIED, 'user denied signing'));
      } else if (result.outcome === 'error') {
        reject(new SignInError(result.error_code ?? ERR_INTERNAL, result.message ?? ''));
      } else {
        reject(new SignInError(ERR_INTERNAL, `unknown outcome: ${result.outcome}`));
      }
    };

    window.addEventListener('message', messageHandler);

    const payload = {
      [MESSAGE_DISCRIMINATOR]: true,
      kind: KIND_STATEMENT_SIGN_REQUEST,
      request_id: requestId,
      rp_origin: request.rpOrigin,
      context: request.context,
      content: request.content,
      content_type: request.contentType ?? 'text/plain',
      nonce: request.nonce ?? null,
      // Only sent when asked for, so older wallets see the 0.1.1 shape.
      ...(request.consent ? { consent: request.consent } : {}),
    };
    window.postMessage(payload, '*');

    timeoutHandle = setTimeout(() => {
      window.removeEventListener('message', messageHandler);
      reject(new SignInError(ERR_TIMEOUT, `no response within ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

// ─── Native app surface ────────────────────────────────────────────────────

/**
 * Deep-link the native MATA app via `mata-mid://`. Resolves when the
 * user returns to the browser tab and the SDK reads `location.hash`
 * for the `mid_response` payload.
 *
 * @internal
 * @param {object} request
 * @param {object} options
 * @param {number} timeoutMs
 * @returns {Promise<{jwt: string, surface: "native_app"}>}
 */
function signInViaNativeApp(request, options, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') {
      reject(new SignInError(ERR_NO_WALLET_INSTALLED, 'no window — server context?'));
      return;
    }

    const requestId = generateRequestId();
    const callback = options.nativeAppCallback ?? window.location.href;

    const payload = {
      version: PROTOCOL_VERSION,
      request_id: requestId,
      rp_origin: request.rpOrigin,
      nonce: request.nonce,
      claims: {
        required: request.claims.required,
        optional: request.claims.optional ?? [],
        custom: request.claims.custom ?? {},
      },
      callback,
    };

    const payloadJson = JSON.stringify(payload);
    const payloadB64 = base64UrlEncode(payloadJson);
    const url = `${URL_SCHEME}://${SCHEME_PATH_REQUEST}?${QUERY_PARAM_PAYLOAD}=${payloadB64}`;

    // Detect resume — when the page comes back (visibilitychange ->
    // visible OR hashchange), inspect location.hash for our response.
    let timeoutHandle = null;
    const resumeHandler = () => {
      const response = extractResponseFromHash(window.location.hash, requestId);
      if (response === null) {
        // Not our response (yet) — keep listening.
        return;
      }
      cleanup();
      // Wipe the fragment so a refresh doesn't replay the response.
      try {
        const cleanUrl = window.location.href.split('#')[0];
        window.history.replaceState(null, '', cleanUrl);
      } catch (_) {
        /* best-effort */
      }
      const result = response.result;
      if (result.outcome === 'ok') {
        resolve({ jwt: result.jwt, surface: 'native_app' });
      } else if (result.outcome === 'denied') {
        reject(new SignInError(ERR_USER_DENIED, 'user denied disclosure'));
      } else {
        reject(new SignInError(result.error_code ?? ERR_INTERNAL, result.message ?? ''));
      }
    };

    const cleanup = () => {
      window.removeEventListener('hashchange', resumeHandler);
      document.removeEventListener('visibilitychange', resumeHandler);
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    };

    window.addEventListener('hashchange', resumeHandler);
    document.addEventListener('visibilitychange', resumeHandler);

    // Try to detect that the URL scheme actually launched a registered
    // app. If the page is still visible 1.5s after dispatching the
    // deep link AND no hash response has arrived, assume no app is
    // installed and reject with `no_wallet_installed`.
    //
    // This heuristic is browser-only: it relies on the OS deep link
    // backgrounding the tab. Inside a native host (a Dioxus/Tauri/wry/
    // Electron webview that embeds this SDK), the page never loses
    // visibility, so the check would false-positive on every call. Hosts
    // that deliver the callback themselves — registering their own scheme
    // and injecting the `#mid_response` fragment back into the webview —
    // pass `options.nativeHost = true` to skip it and rely on the hard
    // timeout instead.
    let noAppCheckHandle = null;
    if (!options.nativeHost) {
      const NO_APP_DETECT_MS = 1500;
      noAppCheckHandle = setTimeout(() => {
        if (document.visibilityState === 'visible') {
          cleanup();
          reject(
            new SignInError(
              ERR_NO_WALLET_INSTALLED,
              'no MATA app responded to the deep link'
            )
          );
        }
      }, NO_APP_DETECT_MS);
    }

    // Hard timeout — user has the configured timeoutMs to complete.
    timeoutHandle = setTimeout(() => {
      cleanup();
      clearTimeout(noAppCheckHandle);
      reject(new SignInError(ERR_TIMEOUT, `no response within ${timeoutMs}ms`));
    }, timeoutMs);

    // Dispatch the deep link.
    window.location.href = url;
  });
}

/**
 * Try to extract a `PageSignInResponse` from the URL hash. Returns
 * `null` if the hash doesn't contain our fragment or the embedded
 * response doesn't match `expectedRequestId`.
 *
 * @internal
 * @param {string} hash
 * @param {string} expectedRequestId
 * @returns {object | null}
 */
function extractResponseFromHash(hash, expectedRequestId) {
  if (!hash || hash.length < 2) return null;
  // Strip leading #
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  const pairs = fragment.split('&');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.slice(0, idx);
    if (key !== FRAGMENT_KEY_RESPONSE) continue;
    const value = pair.slice(idx + 1);
    try {
      const json = base64UrlDecode(value);
      const obj = JSON.parse(json);
      if (obj.request_id === expectedRequestId) {
        return obj;
      }
    } catch (_) {
      // Malformed; keep looking.
    }
  }
  return null;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Generate a UUID v4 for the request_id. Uses `crypto.randomUUID()`
 * where available (modern browsers + Node 19+); falls back to a
 * Math.random()-based generator if not.
 *
 * @internal
 * @returns {string}
 */
export function generateRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback — RFC 4122 v4 layout, not cryptographically random but
  // sufficient for in-flight correlation.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * base64url-encode a string. Browser-compatible (no Buffer).
 *
 * @internal
 * @param {string} str
 * @returns {string}
 */
export function base64UrlEncode(str) {
  // UTF-8 → bytes → base64 → URL-safe charset, no padding.
  const utf8Bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const b of utf8Bytes) binary += String.fromCharCode(b);
  const b64 = btoa(binary);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * base64url-decode to a string.
 *
 * @internal
 * @param {string} b64url
 * @returns {string}
 */
export function base64UrlDecode(b64url) {
  // URL-safe charset → standard base64. Add padding back.
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad === 2) b64 += '==';
  else if (pad === 3) b64 += '=';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ─── Upsell surface re-exports ─────────────────────────────────────────────
//
// Re-exported so RPs that want full control (e.g. their own modal UI)
// can call `showInstallUpsell` directly without depending on the
// internal lazy-import path. They'd typically pass `installUpsell:
// false` to `signIn()`, catch `ERR_NO_WALLET_INSTALLED`, and call
// `showInstallUpsell()` from their own handler.

export {
  showInstallUpsell,
  pickInstallCta,
  defaultRefFromOrigin,
} from './install-upsell.js';

// Resume-after-reload surface. `resumePendingSignIn` is the public
// entry; `clearPendingSignIn` is exposed for RPs who need to drop
// the stash imperatively (e.g. after navigating to a different
// sign-in flow that supersedes the pending mID request).
export { clearPendingSignIn } from './resume.js';
