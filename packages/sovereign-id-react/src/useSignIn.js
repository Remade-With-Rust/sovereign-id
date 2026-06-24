/**
 * `useSignIn` — React hook around `@matanetwork/sovereign-id`'s `signIn`.
 *
 * Manages the full state machine of a sign-in attempt: idle → pending
 * → (success | error). Exposes `signIn(extraRequest)` for the click
 * handler, `reset()` for a clean retry, and the current status fields
 * for rendering.
 *
 * Use this when you want full control over the button / link that
 * triggers sign-in. If you just want a drop-in button, use
 * `<SignInButton/>` from the same package.
 *
 * ## State machine
 *
 *   idle ──signIn()──▶ pending ──┬──▶ success  (result populated)
 *                                └──▶ error    (error populated)
 *
 * Any of those terminal states can transition back to `idle` via
 * `reset()` or to `pending` again via a fresh `signIn()` call.
 *
 * ## Why a hook (not a one-shot helper)
 *
 * Sign-in is async, the UI needs to reflect three distinct phases
 * (idle / pending / done), and the result drives downstream effects
 * (call `/api/auth/mid`, set session, navigate). A hook is the
 * idiomatic React shape for "stateful async operation."
 *
 * ## Stale-call protection
 *
 * If a component re-renders mid-flight or the user clicks the button
 * twice in a row, only the **most recent** signIn() call resolves into
 * state. Earlier calls' results are dropped (their promises still
 * resolve, but their setStates are gated by a request-id check). This
 * prevents a slow first call from clobbering a fast second call's
 * result — common bug class for naive async hooks.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { signIn as sdkSignIn, SignInError } from '@matanetwork/sovereign-id';

/**
 * @typedef {object} UseSignInOptions
 * @property {string} [rpOrigin] - Default `rpOrigin` used by `signIn()`.
 *     If omitted, falls back to `window.location.origin`. RPs running
 *     SSR should set this explicitly.
 * @property {() => Promise<string>} [getNonce] - Async function that
 *     returns a fresh single-use nonce. Called once per `signIn()`
 *     invocation; the resolved string is passed through to the SDK.
 *     If omitted, `signIn()` must be called with a `nonce` directly.
 * @property {object} [defaultClaims] - Default `claims` payload, merged
 *     with the per-call override.
 * @property {boolean} [installUpsell] - Forwarded to the SDK.
 * @property {string | null} [ref] - Forwarded to the SDK. See the
 *     `defaultRefFromOrigin` docs for the auto-derive behavior.
 * @property {number} [timeoutMs] - Forwarded to the SDK.
 * @property {string} [nativeAppCallback] - Forwarded to the SDK.
 */

/**
 * @typedef {object} UseSignInState
 * @property {'idle' | 'pending' | 'success' | 'error'} status
 * @property {boolean} isLoading - True iff `status === 'pending'`.
 * @property {{jwt: string, surface: 'extension' | 'native_app'} | null} result
 * @property {SignInError | null} error
 */

/**
 * @typedef {object} UseSignInReturn
 * @property {(overrides?: object) => Promise<{jwt: string, surface: 'extension' | 'native_app'} | null>} signIn
 *     Fires a sign-in. Merges `overrides` over the hook-level options;
 *     `overrides.nonce` overrides `getNonce()`. Resolves to the result
 *     on success, `null` if the call was superseded by a newer signIn,
 *     or rejects with `SignInError` on failure.
 * @property {() => void} reset - Drops result/error and returns to idle.
 * @property {'idle' | 'pending' | 'success' | 'error'} status
 * @property {boolean} isLoading
 * @property {{jwt: string, surface: 'extension' | 'native_app'} | null} result
 * @property {SignInError | null} error
 */

/**
 * @param {UseSignInOptions} [options]
 * @returns {UseSignInReturn}
 */
export function useSignIn(options = {}) {
  const [state, setState] = useState({
    status: 'idle',
    result: null,
    error: null,
  });

  // Stale-call protection: every signIn() bumps this counter; the
  // resulting promise only commits its outcome to state if it matches
  // the latest counter value at resolve time. Stops a slow first call
  // from overwriting a fast second call.
  const currentRequestIdRef = useRef(0);

  // Mount-tracking so we don't `setState` after unmount (React 18
  // tolerates it, but it still logs a warning). The ref is set by the
  // cleanup function returned from useEffect.
  const isMountedRef = useRef(true);
  useEffect(
    () => () => {
      isMountedRef.current = false;
    },
    []
  );

  // Refs over options so the `signIn` callback doesn't have to be
  // recreated every render when the caller passes inline objects.
  // Stable reference → safe to use as a dep in the caller's own
  // useEffect/useMemo.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const signIn = useCallback(async (overrides = {}) => {
    const myRequestId = ++currentRequestIdRef.current;
    setState({ status: 'pending', result: null, error: null });

    const opts = optionsRef.current;

    // Resolve nonce: caller override > hook-level getNonce().
    let nonce = overrides.nonce;
    if (typeof nonce !== 'string' || nonce.length === 0) {
      if (typeof opts.getNonce !== 'function') {
        const err = new SignInError(
          'invalid_request',
          'useSignIn: no nonce provided and no `getNonce` configured.'
        );
        // Commit only if still latest.
        if (
          currentRequestIdRef.current === myRequestId &&
          isMountedRef.current
        ) {
          setState({ status: 'error', result: null, error: err });
        }
        throw err;
      }
      try {
        nonce = await opts.getNonce();
      } catch (e) {
        const err =
          e instanceof SignInError
            ? e
            : new SignInError(
                'invalid_request',
                `useSignIn: getNonce() threw: ${e?.message ?? e}`
              );
        if (
          currentRequestIdRef.current === myRequestId &&
          isMountedRef.current
        ) {
          setState({ status: 'error', result: null, error: err });
        }
        throw err;
      }
    }

    // Resolve rpOrigin.
    const rpOrigin =
      overrides.rpOrigin ??
      opts.rpOrigin ??
      (typeof window !== 'undefined' ? window.location.origin : undefined);

    // Resolve claims. Caller-level overrides win field-by-field.
    const claims = overrides.claims ??
      opts.defaultClaims ?? { required: ['did'] };

    const request = { rpOrigin, nonce, claims };

    const sdkOpts = {
      installUpsell:
        overrides.installUpsell ?? opts.installUpsell ?? undefined,
      ref: overrides.ref ?? opts.ref,
      timeoutMs: overrides.timeoutMs ?? opts.timeoutMs ?? undefined,
      nativeAppCallback:
        overrides.nativeAppCallback ?? opts.nativeAppCallback ?? undefined,
    };

    try {
      const result = await sdkSignIn(request, sdkOpts);
      if (
        currentRequestIdRef.current === myRequestId &&
        isMountedRef.current
      ) {
        setState({ status: 'success', result, error: null });
      }
      return result;
    } catch (e) {
      const err =
        e instanceof SignInError
          ? e
          : new SignInError(
              'internal_error',
              `useSignIn: unexpected error: ${e?.message ?? e}`
            );
      if (
        currentRequestIdRef.current === myRequestId &&
        isMountedRef.current
      ) {
        setState({ status: 'error', result: null, error: err });
      }
      throw err;
    }
  }, []);

  const reset = useCallback(() => {
    currentRequestIdRef.current++;
    setState({ status: 'idle', result: null, error: null });
  }, []);

  return {
    signIn,
    reset,
    status: state.status,
    isLoading: state.status === 'pending',
    result: state.result,
    error: state.error,
  };
}
