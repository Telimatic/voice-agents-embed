// @vitest-environment node
//
// TLZ-706. The visitor's IP comes only from headers Cloudflare sets itself. Cloudflare
// appends to an X-Forwarded-For the browser already sent, so that header's first entry is
// whatever the browser chose; it is never read.
import { describe, expect, it } from 'vitest';
import { clientIpFromHeaders } from '../client-ip';

function ipFrom(headers: Record<string, string>): string | null {
  return clientIpFromHeaders(new Headers(headers));
}

describe('clientIpFromHeaders — Cloudflare headers only', () => {
  it('reads CF-Connecting-IP', () => {
    expect(ipFrom({ 'cf-connecting-ip': '203.0.113.45' })).toBe('203.0.113.45');
  });

  it('prefers CF-Connecting-IPv6 over a Pseudo-IPv4 CF-Connecting-IP', () => {
    // With Cloudflare's Pseudo IPv4 on, CF-Connecting-IP holds a made-up 240.0.0.0/4
    // address and the visitor's real one moves to CF-Connecting-IPv6.
    expect(ipFrom({ 'cf-connecting-ip': '240.0.0.1', 'cf-connecting-ipv6': '2001:db8::1' })).toBe(
      '2001:db8::1'
    );
  });

  it('ignores CF-Connecting-IPv6 when CF-Connecting-IP holds a real address', () => {
    // Cloudflare overwrites CF-Connecting-IP, but a CF-Connecting-IPv6 the browser sent itself
    // may pass through, so it must not win over a real IPv4.
    expect(
      ipFrom({ 'cf-connecting-ip': '203.0.113.45', 'cf-connecting-ipv6': '2001:db8::bad' })
    ).toBe('203.0.113.45');
  });

  it('ignores CF-Connecting-IPv6 when CF-Connecting-IP is missing', () => {
    expect(ipFrom({ 'cf-connecting-ipv6': '2001:db8::1' })).toBeNull();
  });

  it('records no IP for a Pseudo-IPv4 without a usable CF-Connecting-IPv6', () => {
    expect(ipFrom({ 'cf-connecting-ip': '240.0.0.1' })).toBeNull();
    expect(
      ipFrom({ 'cf-connecting-ip': '240.0.0.1', 'cf-connecting-ipv6': 'not-an-ip' })
    ).toBeNull();
  });

  it('reads a real IPv6 in CF-Connecting-IP', () => {
    expect(ipFrom({ 'cf-connecting-ip': '2001:db8::1' })).toBe('2001:db8::1');
  });

  it('never reads X-Forwarded-For or X-Real-IP', () => {
    expect(ipFrom({ 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '1.2.3.4' })).toBeNull();
  });

  it('rejects anything that is not exactly one IP', () => {
    for (const value of ['not-an-ip', '1.2.3.4, 5.6.7.8', '', '   ']) {
      expect(ipFrom({ 'cf-connecting-ip': value })).toBeNull();
    }
  });

  it('unwraps an IPv4-mapped IPv6 address', () => {
    expect(ipFrom({ 'cf-connecting-ip': '::ffff:203.0.113.45' })).toBe('203.0.113.45');
  });
});
