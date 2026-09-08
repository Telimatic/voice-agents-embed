// lib/embed-config-client.ts
//
// TLZ-561. Server-side only. Asks the dashboard whether screenshare is on for an agent,
// so the token route can restrict canPublishSources before minting.
//
// Every failure path returns "disabled" rather than throwing: this call sits in front of
// every web call's connection, and a screenshare outage must cost the feature, never the
// conversation.
import { createHmac } from 'crypto';
import protocolFixture from '../fixtures/screenshare-protocol.fixture.json';
import type { ShareSurface } from './screenshare-protocol';

/** Short, because every web caller waits on it before the room connects. */
const TIMEOUT_MS = 1_500;

/** The protocol's own list of valid surfaces (fixtures/screenshare-protocol.fixture.json,
 *  asserted against Task 12's screenshare-protocol.ts and the worker's Python mirror), not
 *  redefined here. The signature on this request authenticates who sent these bytes, not
 *  that the bytes are well-formed — the dashboard is a peer we trust for identity, not for
 *  producing values this side has never validated. */
const KNOWN_SURFACES: readonly string[] = protocolFixture.enums.shareSurface;

/** Keeps only values this side actually recognizes as a ShareSurface. Anything else
 *  (a typo, a future surface this widget build predates, a malformed response) is
 *  dropped rather than cast through — an unvalidated string could otherwise reach a
 *  getDisplayMedia-shaped API downstream. */
function sanitizeAllowedSurfaces(value: unknown): ShareSurface[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (v): v is ShareSurface => typeof v === 'string' && KNOWN_SURFACES.includes(v)
  );
}

export interface WidgetScreenshareConfig {
  enabled: boolean;
  reason: string;
  allowedSurfaces?: ShareSurface[];
}

/**
 * Mirrors telzino-dashboard/lib/embed-config-signature.ts's `macInput` exactly. That
 * repo verifies this request; the two must byte-for-byte agree on what gets signed.
 *
 * The timestamp and body are fed to the MAC as separately length-delimited fields
 * rather than a bare `${timestamp}.${body}` concatenation. A plain join has no
 * unambiguous boundary between the two — a body's own bytes could in principle be read
 * as spilling into (or absorbing) the timestamp — which is exactly the bug class a
 * signed request is meant to resist. Framing each field with its byte length and a
 * newline that the length itself cannot contain (it is pure decimal digits) fixes the
 * boundary regardless of what bytes the body holds.
 */
function macInput(body: string, timestamp: number): Buffer {
  const ts = String(timestamp);
  const bodyBuf = Buffer.from(body, 'utf8');
  return Buffer.concat([
    Buffer.from(`${ts.length}\n${ts}`, 'utf8'),
    Buffer.from(`${bodyBuf.length}\n`, 'utf8'),
    bodyBuf,
  ]);
}

/** Exported only for the signature contract test, which checks it byte-for-byte
 *  against the dashboard's own `signEmbedConfigRequest`. Not part of this module's
 *  functional surface otherwise — callers want `fetchScreenshareConfig`. */
export function signEmbedConfigRequest(body: string, timestamp: number, key: string): string {
  return createHmac('sha256', key).update(macInput(body, timestamp)).digest('base64url');
}

export async function fetchScreenshareConfig(agentId: string): Promise<WidgetScreenshareConfig> {
  const url = process.env.DASHBOARD_EMBED_CONFIG_URL;
  const key = process.env.EMBED_CONFIG_KEY_CURRENT;
  if (!url || !key) return { enabled: false, reason: 'not_configured' };

  const body = JSON.stringify({ agentId });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signEmbedConfigRequest(body, timestamp, key);

  try {
    const res = await fetch(url, {
      method: 'POST',
      cache: 'no-store',
      body,
      headers: {
        'content-type': 'application/json',
        'x-embed-timestamp': String(timestamp),
        'x-embed-signature': signature,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { enabled: false, reason: `http_${res.status}` };
    const json = await res.json();
    const ss = json?.screenshare;
    return {
      enabled: ss?.enabled === true,
      reason: typeof ss?.reason === 'string' ? ss.reason : 'unknown',
      allowedSurfaces: sanitizeAllowedSurfaces(ss?.config?.allowed_surfaces),
    };
  } catch (err) {
    console.warn('screenshare config unavailable, continuing audio-only:', err);
    return { enabled: false, reason: 'unreachable' };
  }
}
