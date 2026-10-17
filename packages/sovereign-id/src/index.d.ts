/**
 * Type declarations for @matanetwork/sovereign-id.
 *
 * The runtime is pure JS (no TypeScript build step). This `.d.ts`
 * exists so consumers using TypeScript get full type-checking +
 * IDE intellisense.
 */

// ─── Wire protocol constants ───────────────────────────────────────────────

export const WINDOW_MID_GLOBAL: '__mata_mid__';
export const MESSAGE_DISCRIMINATOR: '__mata_mid_v1';
export const KIND_SIGN_IN_REQUEST: 'sign_in_request';
export const KIND_SIGN_IN_RESPONSE: 'sign_in_response';
export const KIND_STATEMENT_SIGN_REQUEST: 'statement_sign_request';
export const KIND_STATEMENT_SIGN_RESPONSE: 'statement_sign_response';
export const URL_SCHEME: 'mata-mid';
export const SCHEME_PATH_REQUEST: 'request';
export const QUERY_PARAM_PAYLOAD: 'payload';
export const FRAGMENT_KEY_RESPONSE: 'mid_response';
export const PROTOCOL_VERSION: 1;

// ─── Standard error codes ──────────────────────────────────────────────────

export const ERR_USER_DENIED: 'user_denied';
export const ERR_ORIGIN_MISMATCH: 'origin_mismatch';
export const ERR_INVALID_REQUEST: 'invalid_request';
export const ERR_WALLET_UNAVAILABLE: 'wallet_unavailable';
export const ERR_REQUIRED_CLAIM_UNAVAILABLE: 'required_claim_unavailable';
export const ERR_INTERNAL: 'internal_error';
export const ERR_NO_WALLET_INSTALLED: 'no_wallet_installed';
export const ERR_TIMEOUT: 'timeout';
export const ERR_UPSELL_CANCELED: 'upsell_canceled';

export type ErrorCode =
  | typeof ERR_USER_DENIED
  | typeof ERR_ORIGIN_MISMATCH
  | typeof ERR_INVALID_REQUEST
  | typeof ERR_WALLET_UNAVAILABLE
  | typeof ERR_REQUIRED_CLAIM_UNAVAILABLE
  | typeof ERR_INTERNAL
  | typeof ERR_NO_WALLET_INSTALLED
  | typeof ERR_TIMEOUT
  | typeof ERR_UPSELL_CANCELED;

// ─── Request / response types ──────────────────────────────────────────────

export interface CustomClaim {
  optional: true;
  description?: string;
}

export interface SignInRequest {
  /** The RP's bare origin, e.g. `"https://acme.com"`. */
  rpOrigin: string;
  /** RP-issued single-use nonce; appears in the JWT for replay defense. */
  nonce: string;
  /** Claim catalog the wallet should disclose. */
  claims: {
    /** Claims that MUST be approved; denial blocks sign-in. */
    required: string[];
    /** Claims the user can include or skip. */
    optional?: string[];
    /** Arbitrary custom keys from the user's profile_kv (v0: ignored). */
    custom?: Record<string, CustomClaim>;
  };
}

export interface SignInOptions {
  /** Hard request timeout. Default: 120 seconds. */
  timeoutMs?: number;
  /**
   * URL the native app's response will redirect to. Default:
   * `window.location.href`. Only honored when the SDK falls through
   * to the native-app deep link. For a native host, set this to your
   * app's own custom scheme (e.g. `"myapp://mid-callback"`) so the
   * wallet's callback routes back to your app instead of a browser tab.
   */
  nativeAppCallback?: string;
  /**
   * Set `true` when this SDK runs inside a native webview
   * (Dioxus/Tauri/wry/Electron) rather than a real browser tab. Skips
   * the browser-only "no wallet installed" visibility heuristic — which
   * would false-positive because a native webview never backgrounds when
   * the OS opens the deep link — and relies on the hard `timeoutMs`
   * instead. Pair with `nativeAppCallback` and have your host inject the
   * returned `#mid_response=...` fragment back into the webview so the
   * SDK's existing resume listener resolves the `signIn()` promise.
   */
  nativeHost?: boolean;
  /**
   * Whether to show the install upsell modal when no wallet is
   * detected on the user's device. Default: `true`. Set to `false`
   * to get a raw `ERR_NO_WALLET_INSTALLED` rejection and handle
   * the upsell UI yourself.
   */
  installUpsell?: boolean;
  /**
   * Referral code attributed to signups that flow through the install
   * upsell. Default: the hostname extracted from `rpOrigin` (e.g.
   * `"acme.com"`), so RPs get attribution by default without any
   * extra wiring. Pass `null` to opt out of attribution entirely, or
   * a custom string to override (e.g. a configured MATA referral
   * code your team uses).
   *
   * Stamped onto the install CTA and the "create your account" link
   * inside the upsell modal as `?ref=<code>`, following the existing
   * MATA referral convention captured by my.mata.network's welcome
   * view + signup form.
   */
  ref?: string | null;
}

/**
 * One of the CTAs the install upsell can present. Pick by browser/OS.
 * Exposed for RPs that want to render their own upsell UI from the
 * same recommendation engine.
 */
export interface InstallCta {
  /** Button text (e.g. `"Install MATA for Chrome"`). */
  label: string;
  /** Where the button navigates to. */
  url: string;
  /** Sub-text under the CTA (e.g. `"Opens the Chrome Web Store in a new tab"`). */
  hint: string;
}

export interface InstallUpsellOptions {
  /** Shown prominently as the requesting RP. */
  rpOrigin: string;
  /**
   * Inversion-of-control hook so the SDK's `hasExtension()` is used
   * in production and tests can stub it.
   */
  hasExtensionFn?: () => boolean;
  /** Override the auto-picked CTA. */
  cta?: InstallCta;
  /** Default 1000 ms. */
  pollIntervalMs?: number;
  /**
   * Referral code attributed to signups that flow through this
   * upsell. Default: hostname of `rpOrigin`. Pass `null` to disable.
   * See `SignInOptions.ref` for the full attribution model.
   */
  ref?: string | null;
}

export type InstallUpsellResult = 'installed' | 'canceled';

export interface SignInSuccess {
  /** JWS compact-form mID token. */
  jwt: string;
  /** Which surface produced the JWT. */
  surface: 'extension' | 'native_app';
}

export interface SignStatementRequest {
  /** The requesting site's bare origin, e.g. `"https://acme.com"`. */
  rpOrigin: string;
  /** The exact content to sign. */
  content: string;
  /** Domain tag, e.g. `"iamhuman"` or `"janus-adoption-v1"`. */
  context: string;
  /** Media type of `content`. Default: `"text/plain"`. */
  contentType?: string;
  /** Optional single-use nonce. */
  nonce?: string | null;
  /**
   * `"every-time"`: the wallet asks for this signature and never remembers
   * the approval, for statements that hand something over (a device
   * adoption). Omitted, the wallet may reuse a standing grant for
   * (origin, context). Wallets that honour it set
   * `window.__mata_mid__.statementConsentEveryTime`; an older wallet
   * ignores the field, so check that flag first when it matters.
   */
  consent?: 'every-time';
}

export interface SignStatementOptions {
  /** Hard request timeout. Default: 120 seconds. */
  timeoutMs?: number;
}

export interface SignStatementSuccess {
  /** Self-contained `mata-sign` token. */
  token: string;
  /** Which surface produced the token. */
  surface: 'extension';
}

export class SignInError extends Error {
  constructor(code: ErrorCode, message: string);
  readonly code: ErrorCode;
}

// ─── Public functions ──────────────────────────────────────────────────────

export function signIn(
  request: SignInRequest,
  options?: SignInOptions
): Promise<SignInSuccess>;

/**
 * Ask the user's MATA wallet to sign content as their personal DID. The
 * private key never leaves the wallet. Extension surface only for now.
 */
export function signStatement(
  request: SignStatementRequest,
  options?: SignStatementOptions
): Promise<SignStatementSuccess>;

export function hasExtension(): boolean;

/** Internal — exposed for SDK consumers that need to roll their own. */
export function generateRequestId(): string;
/** Internal — exposed for the verifier package + tests. */
export function base64UrlEncode(str: string): string;
/** Internal — exposed for the verifier package + tests. */
export function base64UrlDecode(b64url: string): string;

/**
 * Pick the right install CTA for the user's browser / OS. Auto-called
 * by `signIn()` when the upsell fires; exposed so RPs that opted out
 * of the inline modal can use the same recommendation engine in
 * their own UI.
 */
export function pickInstallCta(): InstallCta;

/**
 * Extract the default referral code from an RP origin — the bare
 * hostname (e.g. `"https://acme.com"` → `"acme.com"`). Exposed so
 * RPs can preview what attribution string they'd get without
 * actually triggering the upsell.
 *
 * Returns `null` for malformed origins.
 */
export function defaultRefFromOrigin(rpOrigin: string): string | null;

/**
 * Render the install upsell overlay and resolve when the user either
 * cancels or completes the install. Auto-called by `signIn()` on
 * `ERR_NO_WALLET_INSTALLED`; exposed for RPs who set
 * `installUpsell: false` and want to invoke it on their own
 * conditions.
 */
export function showInstallUpsell(
  options: InstallUpsellOptions
): Promise<InstallUpsellResult>;

/**
 * Resume a sign-in that was interrupted by a page reload during the
 * install upsell.
 *
 * Call once at app boot — ideally as early as possible — so a user
 * who installed MATA and reloaded sees their sign-in continue without
 * a visible flicker through the logged-out state.
 *
 * - Returns `{jwt, surface}` if a pending request was found, the
 *   extension is now installed, and the resumed sign-in completed.
 * - Returns `null` if no resume is pending, the stash is stale, or
 *   the extension is still missing (the user reloaded before
 *   actually installing).
 * - Rejects with `SignInError` when a pending request exists and the
 *   extension is present but the sign-in itself failed (`user_denied`,
 *   `timeout`, etc.). Same error shape as `signIn()`.
 */
export function resumePendingSignIn(): Promise<SignInSuccess | null>;

/**
 * Imperatively drop any pending resume entry. Useful when the RP
 * has navigated to a different sign-in flow that supersedes the
 * pending mID request.
 */
export function clearPendingSignIn(): void;
