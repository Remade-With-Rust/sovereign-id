/**
 * Type declarations for @matanetwork/sovereign-id-verify.
 */

export interface VerifyConfig {
  /** The RP's bare origin — must equal the JWT's `aud` claim exactly. */
  expectedAudience: string;
  /** The single-use nonce the RP issued for this sign-in session. */
  expectedNonce: string;
  /** Verifier's wall-clock time in unix seconds. */
  nowUnixSecs: number;
  /** Max allowed forward clock skew. Default: 120. */
  maxIatSkewSecs?: number;
}

export interface ClaimValue {
  value: unknown;
  attested_by: 'self';
  verified_at_signup?: boolean;
  computed_at?: number;
  formula_version?: string;
}

export interface VerifiedSovereignId {
  /** The user's DID. RP keys its `users` table on this. */
  did: string;
  /** Hex-encoded SHA-256 of the genesis roster canonical bytes. RP anchors on this. */
  genesisRosterHash: string;
  /** Head roster version. Bump-monotonic; RPs can cache for rollback detection. */
  currentVersion: number;
  /** Claims the user consented to disclose. */
  claims: Record<string, ClaimValue>;
  iat: number;
  exp: number;
  aud: string;
}

export type VerifyErrorCode =
  | 'invalid_jws_shape'
  | 'base64_decode'
  | 'invalid_jws_header'
  | 'payload_json'
  | 'audience_mismatch'
  | 'nonce_mismatch'
  | 'expired'
  | 'not_yet_valid'
  | 'malformed_did'
  | 'malformed_vm_pubkey'
  | 'signature_wrong_length'
  | 'genesis_signature_invalid'
  | 'chain_signer_not_in_prior_roster'
  | 'chain_signature_invalid'
  | 'chain_version_not_monotonic'
  | 'current_vm_not_in_head_roster'
  | 'jwt_signature_invalid'
  | 'rollback_detected';

export class VerifyError extends Error {
  constructor(code: VerifyErrorCode, message: string);
  readonly code: VerifyErrorCode;
}

/**
 * Verify a mID JWT. Throws `VerifyError` on any failure with a
 * specific `.code` identifying the failure mode.
 */
export function verifyResponse(
  jwt: string,
  config: VerifyConfig
): Promise<VerifiedSovereignId>;

/**
 * Optional rollback check the RP runs after a successful verify with
 * the highest version it has seen for the DID.
 */
export function checkRollback(
  verified: VerifiedSovereignId,
  lastSeenVersion: number | null | undefined
): void;
