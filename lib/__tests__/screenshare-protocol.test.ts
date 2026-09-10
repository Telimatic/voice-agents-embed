import { describe, expect, it } from 'vitest';
import fixture from '../../fixtures/screenshare-protocol.fixture.json';
import {
  ATTR_CAPABLE,
  ATTR_ENABLED,
  type ConsentResult,
  RPC_NOTIFY,
  RPC_REQUEST_CONSENT,
  RPC_STOP,
  SCREENSHARE_PROTOCOL_VERSION,
  SHARE_SURFACES,
  type StopReason,
  isCurrentVersion,
} from '../screenshare-protocol';

// Every ConsentResult and StopReason value the TS union declares. Kept as a literal
// list (rather than derived from the type) so a change to the union is caught by
// TypeScript here as a type error, not silently accepted.
const ALL_CONSENT_RESULTS: ConsentResult[] = [
  'granted',
  'declined',
  'timeout',
  'cancelled',
  'failed',
  'unsupported',
];

const ALL_STOP_REASONS: StopReason[] = ['caller_stop', 'browser_stop', 'agent_end', 'agent_left'];

describe('screenshare protocol constants match the shared fixture', () => {
  it('version constant matches the fixture', () => {
    expect(SCREENSHARE_PROTOCOL_VERSION).toBe(fixture.protocolVersion);
  });

  it('RPC method name constants match the fixture', () => {
    expect(RPC_REQUEST_CONSENT).toBe(fixture.rpcMethods.requestConsent);
    expect(RPC_STOP).toBe(fixture.rpcMethods.stop);
    expect(RPC_NOTIFY).toBe(fixture.rpcMethods.notify);
  });

  it('participant attribute key constants match the fixture', () => {
    expect(ATTR_CAPABLE).toBe(fixture.attributes.capable);
    expect(ATTR_ENABLED).toBe(fixture.attributes.enabled);
  });

  it('the attribute values are the stringified booleans the widget publishes', () => {
    // The widget sets ATTR_CAPABLE with String(canCaptureDisplay()) and the worker sets
    // ATTR_ENABLED with a Python string literal. LiveKit attributes are string-to-string,
    // so both sides must agree on exactly these two spellings -- a `True` from Python or a
    // boolean from JS would never match the other side's comparison.
    expect(fixture.attributeValues).toEqual([String(true), String(false)]);
  });

  it('every ConsentResult value appears in the fixture enum list', () => {
    for (const value of ALL_CONSENT_RESULTS) {
      expect(fixture.enums.consentResult).toContain(value);
    }
    // and nothing in the fixture is unknown to the TS union
    for (const value of fixture.enums.consentResult) {
      expect(ALL_CONSENT_RESULTS).toContain(value);
    }
  });

  it('every StopReason value appears in the fixture enum list', () => {
    for (const value of ALL_STOP_REASONS) {
      expect(fixture.enums.stopReason).toContain(value);
    }
    for (const value of fixture.enums.stopReason) {
      expect(ALL_STOP_REASONS).toContain(value);
    }
  });

  it('SHARE_SURFACES matches the fixture, in order', () => {
    // The comment on SHARE_SURFACES claims it is "asserted in screenshare-protocol.test.ts",
    // and until this test it was not. Before the single-definition refactor the list was
    // READ from fixture.enums.shareSurface, so parity held by construction; it is now a
    // hand-typed literal, and the dashboard's widget-config route and the worker's
    // screenshare_protocol.py keep their own copies against the same fixture.
    //
    // toEqual, not toContain in both directions like the enums above: order is load-bearing
    // here. preferredSurface walks this list to pick the LEAST invasive surface the
    // caller's policy allows, so a reordered list silently changes what a caller is asked
    // to share.
    expect([...SHARE_SURFACES]).toEqual(fixture.enums.shareSurface);
  });

  it('requestConsent example matches the RequestConsentPayload/Response shapes', () => {
    const payload = fixture.examples.requestConsentPayload;
    expect(isCurrentVersion(payload)).toBe(true);
    expect(Array.isArray(payload.scope)).toBe(true);
    expect(payload.viewers).toEqual([{ role: 'agent' }]);
    expect(typeof payload.timeout_seconds).toBe('number');

    const response = fixture.examples.requestConsentResponse;
    expect(isCurrentVersion(response)).toBe(true);
    expect(ALL_CONSENT_RESULTS).toContain(response.result);
  });

  it('stop example matches the StopPayload/StopResponse shapes', () => {
    const payload = fixture.examples.stopPayload;
    expect(isCurrentVersion(payload)).toBe(true);

    const response = fixture.examples.stopResponse;
    expect(isCurrentVersion(response)).toBe(true);
    expect(response.stopped).toBe(true);
  });

  it('notify example matches the NotifyPayload/NotifyResponse shapes', () => {
    const payload = fixture.examples.notifyPayload;
    expect(isCurrentVersion(payload)).toBe(true);
    expect(['consent', 'started', 'stopped', 'failed']).toContain(payload.event);
    expect(['agent', 'caller']).toContain(payload.initiated_by);

    const response = fixture.examples.notifyResponse;
    expect(isCurrentVersion(response)).toBe(true);
    expect(response.ok).toBe(true);
  });
});

describe('isCurrentVersion', () => {
  it('accepts the current version', () => {
    expect(isCurrentVersion({ v: SCREENSHARE_PROTOCOL_VERSION })).toBe(true);
  });

  it('rejects a missing v', () => {
    expect(isCurrentVersion({})).toBe(false);
  });

  it('rejects a wrong v', () => {
    expect(isCurrentVersion({ v: SCREENSHARE_PROTOCOL_VERSION + 1 })).toBe(false);
    expect(isCurrentVersion({ v: 0 })).toBe(false);
    expect(isCurrentVersion({ v: '1' })).toBe(false);
  });
});
