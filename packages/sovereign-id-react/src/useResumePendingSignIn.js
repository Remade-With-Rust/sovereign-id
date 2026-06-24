/**
 * `useResumePendingSignIn` — React hook around
 * `resumePendingSignIn()`.
 *
 * Call once at the root of your app. The hook fires
 * `resumePendingSignIn()` on first mount, manages the resolution
 * state, and invokes `onSuccess` / `onError` (if provided) when the
 * resume completes.
 *
 * ## What it solves
 *
 * The install-upsell flow stashes a pending sign-in in
 * `sessionStorage` so it survives a page reload (common when Chrome
 * prompts the user to reload after extension install). On the next
 * boot, the SDK's `resumePendingSignIn()` picks the flow back up. RPs
 * that want this resume path need to call it explicitly — this hook
 * makes that "drop it in App.jsx and forget" simple.
 *
 * ## Idempotent at boot
 *
 * Internally guards with a ref so React 18's strict-mode
 * double-invoke doesn't fire two parallel resume calls. Whichever
 * one wins commits; the other's result is dropped.
 *
 * ## Status reporting
 *
 * Exposes the same `status` shape as `useSignIn` so RPs that mount
 * loading UI can share the rendering branch:
 *
 *   - `idle` — hook hasn't started checking yet (one paint at most).
 *   - `pending` — `resumePendingSignIn()` is in flight.
 *   - `success` — a resume returned a JWT. Result is in `.result`.
 *   - `error` — a resume found a pending request and the SDK threw
 *     while completing it. Error is in `.error`.
 *   - `idle` (with `noResume: true`) — explicitly: no pending
 *     resume was found.
 */

import { useEffect, useRef, useState } from 'react';
import {
  resumePendingSignIn as sdkResume,
  SignInError,
} from '@matanetwork/sovereign-id';

/**
 * @typedef {object} UseResumeOptions
 * @property {(result: {jwt: string, surface: 'extension' | 'native_app'}) => void} [onSuccess]
 *     Called when a pending sign-in resumes and completes. RPs hand
 *     the JWT to their backend here.
 * @property {(err: SignInError) => void} [onError]
 *     Called when a pending sign-in was found but its resume threw.
 *     `err.code` is the same set the regular signIn() throws.
 * @property {() => void} [onNothingPending]
 *     Called when there's no pending resume — most boots. Lets RPs
 *     telemetry "did we hit the resume path on this boot" without
 *     watching the `noResume` flag.
 */

/**
 * @typedef {object} UseResumeReturn
 * @property {'idle' | 'pending' | 'success' | 'error'} status
 * @property {{jwt: string, surface: 'extension' | 'native_app'} | null} result
 * @property {SignInError | null} error
 * @property {boolean} noResume
 *     `true` once we've finished checking and confirmed no pending
 *     sign-in was waiting. Useful for RPs that want to delay
 *     rendering their logged-out UI until the resume check is done
 *     (avoids a flicker through the logged-out state when the
 *     resume succeeds).
 */

/**
 * @param {UseResumeOptions} [options]
 * @returns {UseResumeReturn}
 */
export function useResumePendingSignIn(options = {}) {
  const [state, setState] = useState({
    status: 'idle',
    result: null,
    error: null,
    noResume: false,
  });

  // Guard against React 18 strict-mode double-mount. The first mount
  // fires the resume; the dev-mode second mount is a no-op.
  const hasStartedRef = useRef(false);

  // Keep callbacks in a ref so the boot effect doesn't need to
  // re-fire when the parent re-renders with new inline callbacks.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    if (hasStartedRef.current) return;
    hasStartedRef.current = true;

    let cancelled = false;
    setState((s) => ({ ...s, status: 'pending' }));

    (async () => {
      try {
        const result = await sdkResume();
        if (cancelled) return;
        if (result) {
          setState({
            status: 'success',
            result,
            error: null,
            noResume: false,
          });
          optionsRef.current.onSuccess?.(result);
        } else {
          setState({
            status: 'idle',
            result: null,
            error: null,
            noResume: true,
          });
          optionsRef.current.onNothingPending?.();
        }
      } catch (e) {
        if (cancelled) return;
        const err =
          e instanceof SignInError
            ? e
            : new SignInError(
                'internal_error',
                `useResumePendingSignIn: unexpected error: ${e?.message ?? e}`
              );
        setState({
          status: 'error',
          result: null,
          error: err,
          noResume: false,
        });
        optionsRef.current.onError?.(err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
