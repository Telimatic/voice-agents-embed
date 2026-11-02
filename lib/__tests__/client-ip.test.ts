// @vitest-environment node
//
// TLZ-706. The visitor's IP comes only from headers Cloudflare sets itself. Cloudflare
// appends to an X-Forwarded-For the browser already sent, so that header's first entry is
// whatever the browser chose; it is never read.
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { describe, expect, it } from 'vitest';
import { clientIpFromHeaders, ipVersion } from '../client-ip';

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

describe('ipVersion — plain-code check, the same answers as node:net isIP', () => {
  // Expected answers, written out so the rules can be read here.
  const TABLE: Array<[string, 0 | 4 | 6]> = [
    ['203.0.113.45', 4],
    ['0.0.0.0', 4],
    ['255.255.255.255', 4],
    ['256.1.1.1', 0],
    ['01.2.3.4', 0],
    ['1.2.3', 0],
    ['1.2.3.4.5', 0],
    [' 1.2.3.4', 0],
    ['2001:db8::1', 6],
    ['2001:DB8::ABCD', 6],
    ['::', 6],
    ['::1', 6],
    ['1:2:3:4:5:6:7:8', 6],
    ['1:2:3:4:5:6:7::', 6],
    ['::2:3:4:5:6:7:8', 6],
    ['::ffff:203.0.113.45', 6],
    ['64:ff9b::192.0.2.33', 6],
    ['1:2:3:4:5:6:1.2.3.4', 6],
    ['fe80::1%eth0', 6],
    ['1:2:3:4:5:6:7:8:9', 0],
    ['1:2:3:4:5:6:7', 0],
    ['1::2::3', 0],
    [':::', 0],
    [':1::', 0],
    ['12345::', 0],
    ['g::1', 0],
    ['1.2.3.4::', 0],
    ['::1.2.3', 0],
    ['1:2:3:4:5:6::1.2.3.4', 0],
    ['fe80::1%', 0],
    ['', 0],
    ['not-an-ip', 0],
    ['1.2.3.4%x', 0],
    ['fe80::1%eth_0', 0],
    ['::1%%x', 0],
  ];

  it.each(TABLE)('%s → %i', (value, expected) => {
    expect(ipVersion(value)).toBe(expected);
  });

  it('agrees with node:net isIP on the table, more edge cases and 5,000 seeded random strings', () => {
    const inputs = [
      ...TABLE.map(([value]) => value),
      '::%x',
      '%eth0',
      '1:2:3:4:5:6:7:8%a.b-c:d',
      '::FFFF:1.2.3.4',
      '127.1',
      '0x7f.0.0.1',
      '1.2.3.4\n',
      ...seededAddresses(5000),
    ];
    // The sample must hold IPv4, IPv6 and non-IP strings, or the comparison proves little.
    expect(new Set(inputs.map((value) => isIP(value)))).toEqual(new Set([0, 4, 6]));
    expect(inputs.filter((value) => ipVersion(value) !== isIP(value))).toEqual([]);
  });

  it('imports nothing, so it runs on any server runtime (Node or edge)', () => {
    const source = readFileSync(new URL('../client-ip.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(/);
  });
});

/** A fixed-seed mix of IPv4-like, IPv6-like and broken strings, the same on every run. */
function seededAddresses(count: number): string[] {
  let seed = 706;
  const random = () => {
    // mulberry32
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(random() * n);
  const pick = <T>(items: ArrayLike<T>): T => items[int(items.length)];

  const ipv4 = () =>
    Array.from({ length: pick([3, 4, 4, 4, 4, 5]) }, () =>
      random() < 0.05 ? `0${int(300)}` : String(int(random() < 0.9 ? 256 : 300))
    ).join('.');
  const group = () =>
    Array.from({ length: random() < 0.95 ? 1 + int(4) : pick([0, 5]) }, () =>
      pick('0123456789abcdefABCDEF')
    ).join('');
  const ipv6 = () => {
    const groups = Array.from({ length: pick([6, 7, 8, 8, 8, 8, 9]) }, group);
    if (random() < 0.3) groups.splice(-2, 2, ipv4());
    const at = int(groups.length + 1);
    let text =
      random() < 0.6
        ? `${groups.slice(0, at).join(':')}::${groups.slice(at + int(3)).join(':')}`
        : groups.join(':');
    if (random() < 0.1) text += `%${pick(['eth0', '1', '', 'a.b-c:d', 'x%y'])}`;
    return text;
  };
  const mutate = (text: string) => {
    const at = int(text.length + 1);
    return random() < 0.5
      ? text.slice(0, at) + pick(':.%0fgZ ') + text.slice(at)
      : text.slice(0, at) + text.slice(at + 1);
  };

  return Array.from({ length: count }, () => {
    const text = random() < 0.4 ? ipv4() : ipv6();
    return random() < 0.3 ? mutate(text) : text;
  });
}
