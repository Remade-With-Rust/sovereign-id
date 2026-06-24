/**
 * Type declarations for @matanetwork/sovereign-id-react.
 *
 * Mirrors the JS runtime exactly. The runtime is pure JS (no build
 * step); this `.d.ts` exists so consumers using TypeScript get full
 * type-checking + IDE intellisense.
 */

import type { CSSProperties, ReactNode, ButtonHTMLAttributes } from 'react';
import type {
  SignInError,
  SignInRequest,
  SignInSuccess,
  ErrorCode,
} from '@matanetwork/sovereign-id';

// ─── Hook: useSignIn ───────────────────────────────────────────────────────

export interface UseSignInOptions {
  /**
   * Default `rpOrigin` used by `signIn()`. If omitted, falls back to
   * `window.location.origin`. RPs running SSR should set this
   * explicitly.
   */
  rpOrigin?: string;

  /**
   * Async function that returns a fresh single-use nonce. Called
   * once per `signIn()` invocation; the resolved string is passed
   * through to the SDK. If omitted, `signIn()` must be called with
   * a `nonce` override directly.
   */
  getNonce?: () => Promise<string>;

  /**
   * Default `claims` payload, merged with the per-call override.
   * Almost always `{ required: ['did'], optional: [...] }`.
   */
  defaultClaims?: SignInRequest['claims'];

  /**
   * Forwarded to the SDK. When `false`, throws
   * `ERR_NO_WALLET_INSTALLED` raw instead of showing the install
   * upsell. Default: SDK default (`true`).
   */
  installUpsell?: boolean;

  /**
   * Forwarded to the SDK. Referral code attributed to signups that
   * flow through the install upsell. Defaults to the hostname of
   * `rpOrigin`. Pass `null` to opt out.
   */
  ref?: string | null;

  /** Forwarded to the SDK. */
  timeoutMs?: number;

  /** Forwarded to the SDK. */
  nativeAppCallback?: string;
}

export type SignInStatus = 'idle' | 'pending' | 'success' | 'error';

export interface SignInOverrides {
  rpOrigin?: string;
  nonce?: string;
  claims?: SignInRequest['claims'];
  installUpsell?: boolean;
  ref?: string | null;
  timeoutMs?: number;
  nativeAppCallback?: string;
}

export interface UseSignInReturn {
  /**
   * Fires a sign-in. Merges `overrides` over the hook-level
   * options. Resolves to the result on success, `null` if the call
   * was superseded by a newer signIn, or rejects with `SignInError`
   * on failure.
   */
  signIn(overrides?: SignInOverrides): Promise<SignInSuccess | null>;
  /** Drops result/error and returns to idle. */
  reset(): void;
  status: SignInStatus;
  /** True iff `status === 'pending'`. */
  isLoading: boolean;
  result: SignInSuccess | null;
  error: SignInError | null;
}

export function useSignIn(options?: UseSignInOptions): UseSignInReturn;

// ─── Hook: useResumePendingSignIn ──────────────────────────────────────────

export interface UseResumeOptions {
  /**
   * Called when a pending sign-in resumes and completes. RPs hand
   * the JWT to their backend here.
   */
  onSuccess?: (result: SignInSuccess) => void;
  /**
   * Called when a pending sign-in was found but its resume threw.
   * `err.code` is the same set the regular signIn() throws.
   */
  onError?: (err: SignInError) => void;
  /**
   * Called when there's no pending resume — most boots. Lets RPs
   * record analytics on "did we hit the resume path on this boot"
   * without watching the `noResume` flag.
   */
  onNothingPending?: () => void;
}

export interface UseResumeReturn {
  status: SignInStatus;
  result: SignInSuccess | null;
  error: SignInError | null;
  /**
   * `true` once we've finished checking and confirmed no pending
   * sign-in was waiting. Useful for RPs that want to delay
   * rendering their logged-out UI until the resume check is done.
   */
  noResume: boolean;
}

export function useResumePendingSignIn(options?: UseResumeOptions): UseResumeReturn;

// ─── Component: SignInButton ───────────────────────────────────────────────

export interface SignInButtonProps {
  /** Defaults to `window.location.origin`. */
  rpOrigin?: string;
  /** Async fn returning a fresh single-use nonce from your backend. */
  getNonce: () => Promise<string>;
  /** Claim catalog. `{ required: [...], optional?: [...] }`. */
  claims: SignInRequest['claims'];
  /** Called with the resulting JWT. */
  onSuccess: (result: SignInSuccess) => void;
  /**
   * Called when the user explicitly chose not to sign in
   * (`user_denied` from the consent screen, `upsell_canceled` from
   * the install upsell modal).
   */
  onCancel?: (code: 'user_denied' | 'upsell_canceled') => void;
  /**
   * Called for any other failure path (timeout, wallet_unavailable,
   * etc.). If omitted, errors are silently swallowed — RPs should
   * usually pass at least a logger here.
   */
  onError?: (err: SignInError) => void;
  /** SDK option pass-through. */
  installUpsell?: boolean;
  /** SDK referral code; defaults to the hostname of `rpOrigin`. */
  ref?: string | null;
  /** SDK option pass-through. */
  timeoutMs?: number;
  /** SDK option pass-through. */
  nativeAppCallback?: string;
  /** Button label. Defaults to `"Sign in with Sovereign ID"`. */
  children?: ReactNode;
  /**
   * When set, the default inline styles are NOT applied; the RP has
   * full control via CSS.
   */
  className?: string;
  /**
   * Merged with the default inline styles when `className` is not
   * provided.
   */
  style?: CSSProperties;
  /**
   * Explicitly disable the button. The button is also disabled
   * internally while a sign-in is in flight.
   */
  disabled?: boolean;
  /** Spread onto the underlying `<button>`. */
  buttonProps?: Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    'onClick' | 'disabled' | 'type' | 'style' | 'className' | 'children'
  >;
}

export function SignInButton(props: SignInButtonProps): JSX.Element;

// ─── Re-exports from @matanetwork/sovereign-id ────────────────────────────

export {
  SignInError,
  hasExtension,
  showInstallUpsell,
  pickInstallCta,
  defaultRefFromOrigin,
  clearPendingSignIn,
  resumePendingSignIn,
  signIn,
  PROTOCOL_VERSION,
  WINDOW_MID_GLOBAL,
  MESSAGE_DISCRIMINATOR,
  KIND_SIGN_IN_REQUEST,
  KIND_SIGN_IN_RESPONSE,
  URL_SCHEME,
  SCHEME_PATH_REQUEST,
  QUERY_PARAM_PAYLOAD,
  FRAGMENT_KEY_RESPONSE,
  ERR_USER_DENIED,
  ERR_ORIGIN_MISMATCH,
  ERR_INVALID_REQUEST,
  ERR_WALLET_UNAVAILABLE,
  ERR_REQUIRED_CLAIM_UNAVAILABLE,
  ERR_INTERNAL,
  ERR_NO_WALLET_INSTALLED,
  ERR_TIMEOUT,
  ERR_UPSELL_CANCELED,
} from '@matanetwork/sovereign-id';

export type {
  SignInRequest,
  SignInSuccess,
  ErrorCode,
  CustomClaim,
  InstallCta,
  InstallUpsellOptions,
  InstallUpsellResult,
  SignInOptions,
} from '@matanetwork/sovereign-id';
