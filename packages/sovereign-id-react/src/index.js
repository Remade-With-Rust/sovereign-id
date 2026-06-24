/**
 * @matanetwork/sovereign-id-react — React adapter for the
 * `@matanetwork/sovereign-id` SDK.
 *
 * Three entry points:
 *
 *  - [`<SignInButton/>`](./SignInButton.js) — drop-in styled button.
 *    Three required props: `getNonce`, `claims`, `onSuccess`.
 *
 *  - [`useSignIn`](./useSignIn.js) — hook for RPs that want their
 *    own button. Returns `{ signIn, status, isLoading, result, error,
 *    reset }`.
 *
 *  - [`useResumePendingSignIn`](./useResumePendingSignIn.js) — boot-
 *    time hook. Call once at the root of your app to handle the
 *    resume-after-reload path that the install upsell sets up.
 *
 * Everything else (`SignInError`, error codes, `defaultRefFromOrigin`,
 * etc.) is re-exported from `@matanetwork/sovereign-id` so RPs only
 * need one import line.
 */

export { SignInButton } from './SignInButton.js';
export { useSignIn } from './useSignIn.js';
export { useResumePendingSignIn } from './useResumePendingSignIn.js';

// Re-export the core SDK surface so RPs don't have to install both
// packages just to type their callbacks against `SignInError`.
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
