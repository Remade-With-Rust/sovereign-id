/**
 * @matanetwork/sign-verify — type declarations.
 */

/** Options for {@link verifyStatement}. */
export interface VerifyStatementOptions {
  /** Current wall-clock time, Unix seconds. */
  nowUnixSecs: number;
  /** Maximum allowed forward clock skew between the signer's `iat` and now, in seconds. Default 120. */
  maxIatSkewSecs?: number;
  /** If set, the statement's `context` MUST equal this exactly (e.g. `"iamhuman"`). */
  expectedContext?: string;
  /** If set, the statement's `nonce` MUST equal this exactly. */
  expectedNonce?: string;
}

/** A successfully verified statement. */
export interface VerifiedStatement {
  /** The signer's DID — proven to control the signing key. */
  did: string;
  /** The committed content digest, lowercase hex SHA-256 (64 chars). */
  contentHash: string;
  /** The media type the signer recorded (e.g. `"text/plain"`). */
  contentType: string;
  /** The head roster version (monotonic; rollback-detection signal). */
  currentVersion: number;
  /** Issued-at, Unix seconds. */
  iat: number;
  /** Expiry, Unix seconds, or `null` if the signer set none. */
  exp: number | null;
  /** The domain tag the signer set, or `null`. */
  context: string | null;
  /** Inlined short-text preview, or `null`. */
  preview: string | null;
}

/**
 * Verify a MATA signed-statement token. Runs the four self-contained
 * cryptographic checks, freshness, and optional context/nonce binding.
 * Resolves with a {@link VerifiedStatement}; rejects with {@link VerifyError}.
 *
 * Does NOT check the content bytes — call {@link matchesContent} with the
 * content you hold to bind who-signed to what-was-signed.
 */
export function verifyStatement(
  token: string,
  opts: VerifyStatementOptions
): Promise<VerifiedStatement>;

/**
 * Confirm `content` is exactly what was signed: recompute SHA-256 and compare
 * to the verified statement's committed hash.
 */
export function matchesContent(
  verified: VerifiedStatement,
  content: string | Uint8Array | ArrayBuffer | Buffer
): boolean;

/** Error thrown on any verification failure. `.code` is a stable snake_case string. */
export class VerifyError extends Error {
  code: string;
  constructor(code: string, message: string);
}
