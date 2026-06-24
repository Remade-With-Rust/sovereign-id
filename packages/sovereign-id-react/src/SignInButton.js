/**
 * `<SignInButton/>` — drop-in React button that runs the full
 * Sovereign ID sign-in flow on click.
 *
 * RPs that just want a working button drop this in and pass an
 * `onSuccess` callback that hands the JWT to their backend. Custom
 * styling via `className` / `style` / `children`. RPs that need more
 * control over the click handler should use `useSignIn()` directly.
 *
 * ## Rendering note (no JSX)
 *
 * Authored with `React.createElement` so this package can ship as
 * pure ESM with no build step. Bundlers (Vite / Webpack / esbuild)
 * still tree-shake, type-check, etc. — they just don't have to
 * transpile JSX. Keeps the package single-file-readable and zero-
 * configure.
 *
 * ## What clicking does
 *
 * 1. Sets internal `loading` state.
 * 2. Resolves the nonce via `getNonce` (required prop).
 * 3. Calls the SDK's `signIn({ rpOrigin, nonce, claims })`.
 * 4. On success, calls `onSuccess({ jwt, surface })`.
 * 5. On `user_denied` / `upsell_canceled`, calls `onCancel(code)`.
 * 6. On any other failure, calls `onError(err)`.
 * 7. Resets loading state and re-enables the button.
 *
 * The button is `disabled` for the duration of step 1-6 so duplicate
 * clicks are no-ops.
 */

import { createElement } from 'react';
import { SignInError } from '@matanetwork/sovereign-id';
import { useSignIn } from './useSignIn.js';

const DEFAULT_LABEL = 'Sign in with Sovereign ID';

const DEFAULT_BUTTON_STYLE = {
  // Match the popup CSS palette so the button feels at-home next to
  // the consent screen that opens after the click.
  background: '#4b2ad5',
  color: '#fff',
  border: 'none',
  borderRadius: '8px',
  padding: '10px 18px',
  font: 'inherit',
  fontSize: '14px',
  fontWeight: 600,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '8px',
  lineHeight: 1.3,
  transition: 'background 0.12s ease',
};

const DEFAULT_BUTTON_STYLE_DISABLED = {
  ...DEFAULT_BUTTON_STYLE,
  opacity: 0.6,
  cursor: 'not-allowed',
};

/**
 * @param {object} props
 * @param {string} [props.rpOrigin] - Defaults to `window.location.origin`.
 * @param {() => Promise<string>} props.getNonce - Async fn returning a
 *     fresh single-use nonce from your backend. Required.
 * @param {object} props.claims - Claim catalog. `{ required: [...],
 *     optional?: [...], custom?: {...} }`. Required.
 * @param {(result: {jwt: string, surface: 'extension' | 'native_app'}) => void} props.onSuccess
 *     Called with the resulting JWT.
 * @param {(code: 'user_denied' | 'upsell_canceled') => void} [props.onCancel]
 *     Called when the user explicitly chose not to sign in.
 * @param {(err: SignInError) => void} [props.onError]
 *     Called for any other failure path (timeout, wallet_unavailable,
 *     etc.). If omitted, errors are silently swallowed — RPs should
 *     usually pass at least a logger here.
 * @param {boolean} [props.installUpsell] - SDK option pass-through.
 * @param {string | null} [props.ref] - SDK referral code; defaults
 *     to the hostname of `rpOrigin`.
 * @param {number} [props.timeoutMs] - SDK option pass-through.
 * @param {string} [props.nativeAppCallback] - SDK option pass-through.
 * @param {React.ReactNode} [props.children] - Button label. Defaults
 *     to `"Sign in with Sovereign ID"`.
 * @param {string} [props.className] - When set, the default styles
 *     are NOT applied (assume the RP has full control via CSS).
 * @param {React.CSSProperties} [props.style] - Merged with the
 *     default inline styles when `className` is not provided.
 * @param {boolean} [props.disabled] - Explicitly disable the button.
 *     The button is also disabled internally while a sign-in is in
 *     flight; this prop is OR'd with that.
 * @param {object} [props.buttonProps] - Spread onto the underlying
 *     `<button>` for things like `aria-*`, `data-*`, etc.
 */
export function SignInButton(props) {
  const {
    rpOrigin,
    getNonce,
    claims,
    onSuccess,
    onCancel,
    onError,
    installUpsell,
    ref,
    timeoutMs,
    nativeAppCallback,
    children,
    className,
    style,
    disabled = false,
    buttonProps = {},
  } = props;

  const { signIn, isLoading } = useSignIn({
    rpOrigin,
    getNonce,
    defaultClaims: claims,
    installUpsell,
    ref,
    timeoutMs,
    nativeAppCallback,
  });

  const isDisabled = disabled || isLoading;

  const handleClick = async () => {
    if (isDisabled) return;
    try {
      const result = await signIn();
      if (result && typeof onSuccess === 'function') {
        onSuccess(result);
      }
    } catch (err) {
      if (err instanceof SignInError) {
        if (
          (err.code === 'user_denied' || err.code === 'upsell_canceled') &&
          typeof onCancel === 'function'
        ) {
          onCancel(err.code);
          return;
        }
      }
      if (typeof onError === 'function') {
        onError(err);
      }
    }
  };

  // When `className` is provided, defer fully to caller CSS — don't
  // apply the default inline styles at all. When not, ship a sensible
  // styled button and let `style` override fields one at a time.
  const resolvedStyle = className
    ? style
    : { ...(isDisabled ? DEFAULT_BUTTON_STYLE_DISABLED : DEFAULT_BUTTON_STYLE), ...style };

  return createElement(
    'button',
    {
      type: 'button',
      onClick: handleClick,
      disabled: isDisabled,
      'aria-busy': isLoading || undefined,
      className,
      style: resolvedStyle,
      ...buttonProps,
    },
    children ?? DEFAULT_LABEL
  );
}
