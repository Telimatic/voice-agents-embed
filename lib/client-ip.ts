import { isIP } from 'node:net';

/** Minted into the widget's token by the connection-details route (TLZ-706). The worker
 *  reads it to record the caller's public IP on the call. */
export const ATTR_CLIENT_IP = 'telzino.client_ip';

const IPV4_MAPPED_PREFIX = '::ffff:';

// CF-Connecting-IP is set by Cloudflare itself, replacing any copy the browser sent. With
// Cloudflare's Pseudo IPv4 on, it holds a made-up 240.0.0.0/4 address and the visitor's real
// one is in CF-Connecting-IPv6, so that header is read only then: nothing shows Cloudflare
// removes a CF-Connecting-IPv6 the browser sent itself. X-Forwarded-For and X-Real-IP are
// never read: Cloudflare appends to an X-Forwarded-For the browser already sent, so its first
// entry is whatever the browser chose. These headers can only be trusted while the origin is
// reachable through Cloudflare alone.

/** The visitor's public IP (IPv4 or IPv6), or null when no Cloudflare header holds one. */
export function clientIpFromHeaders(headers: Headers): string | null {
  const ip = ipFromHeader(headers, 'cf-connecting-ip');
  if (ip === null || !isPseudoIpv4(ip)) return ip;
  return ipFromHeader(headers, 'cf-connecting-ipv6');
}

/** One header's value as a single IP, IPv4-mapped IPv6 unwrapped; null when it is not one. */
function ipFromHeader(headers: Headers, name: string): string | null {
  const value = headers.get(name)?.trim();
  if (!value || isIP(value) === 0) return null;

  const unmapped = value.slice(IPV4_MAPPED_PREFIX.length);
  if (value.toLowerCase().startsWith(IPV4_MAPPED_PREFIX) && isIP(unmapped) === 4) {
    return unmapped;
  }
  return value;
}

/** True for Cloudflare's Pseudo IPv4 range, 240.0.0.0/4: never a visitor's real address. */
function isPseudoIpv4(ip: string): boolean {
  return isIP(ip) === 4 && Number(ip.split('.')[0]) >= 240;
}
