// TLZ-742 — checks the 5-minute web call session token a partner's page passes to the widget.
//
// The partner's server creates a session in the Telzino Dashboard
// (POST /v1/agents/{id}/web-call-sessions), which saves the call's business details and mints
// this token: `<base64url(payload)>.<base64url(HMAC-SHA256(payload))>`, payload
// `{ typ: 'web_call_session', sid, agent, origin, exp }`. Both sides share the secret
// WEB_CALL_SESSION_TOKEN_SECRET. The token names one session, one agent and the only website
// origin the call may start from; it never carries the business details themselves.
//
// Web Crypto only (no Node-only imports), so this runs in any runtime the route is moved to.

/** Room metadata key the worker reads the session id from at job start. */
export const ROOM_METADATA_SESSION_KEY = 'telzino_web_call_session';

const TOKEN_TYPE = 'web_call_session';

export type WebCallSessionTokenErrorCode =
  | 'malformed'
  | 'bad_signature'
  | 'wrong_type'
  | 'expired'
  | 'origin_mismatch';

export class WebCallSessionTokenError extends Error {
  constructor(public readonly code: WebCallSessionTokenErrorCode) {
    super(code);
    this.name = 'WebCallSessionTokenError';
  }
}

function base64UrlToBytes(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new WebCallSessionTokenError('malformed');
  const b64 =
    value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(b64);
  } catch {
    throw new WebCallSessionTokenError('malformed');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Verify the token's signature, type and expiry, and that it is used from the origin it was
 * issued for. Returns the session and agent it names; the caller must use only these ids.
 */
export async function verifyWebCallSessionToken(
  token: string,
  requestOrigin: string | null,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<{ sessionId: string; agentId: string }> {
  if (typeof token !== 'string') throw new WebCallSessionTokenError('malformed');
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new WebCallSessionTokenError('malformed');
  const [payloadB64, sigB64] = parts;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    base64UrlToBytes(sigB64),
    encoder.encode(payloadB64)
  );
  if (!valid) throw new WebCallSessionTokenError('bad_signature');

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadB64)));
  } catch {
    throw new WebCallSessionTokenError('malformed');
  }
  if (!payload || typeof payload !== 'object' || payload.typ !== TOKEN_TYPE) {
    throw new WebCallSessionTokenError('wrong_type');
  }
  const { sid, agent, origin, exp } = payload;
  if (
    typeof sid !== 'string' ||
    typeof agent !== 'string' ||
    typeof origin !== 'string' ||
    typeof exp !== 'number'
  ) {
    throw new WebCallSessionTokenError('malformed');
  }
  if (nowSeconds >= exp) throw new WebCallSessionTokenError('expired');
  if (!requestOrigin || origin !== requestOrigin) {
    throw new WebCallSessionTokenError('origin_mismatch');
  }
  return { sessionId: sid, agentId: agent };
}
