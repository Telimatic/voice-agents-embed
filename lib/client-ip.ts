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
  if (!value || ipVersion(value) === 0) return null;

  const unmapped = value.slice(IPV4_MAPPED_PREFIX.length);
  if (value.toLowerCase().startsWith(IPV4_MAPPED_PREFIX) && ipVersion(unmapped) === 4) {
    return unmapped;
  }
  return value;
}

/** True for Cloudflare's Pseudo IPv4 range, 240.0.0.0/4: never a visitor's real address. */
function isPseudoIpv4(ip: string): boolean {
  return ipVersion(ip) === 4 && Number(ip.split('.')[0]) >= 240;
}

// The IP check is plain code with no imports (no `node:net`), so this file runs on any server
// runtime, Node or edge. It accepts the same strings as Node's `isIP`.

const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)$/;
const IPV6_GROUP = /^[0-9a-f]{1,4}$/i;
const IPV6_ZONE = /^[0-9a-z.:-]+$/i;

/** 4 or 6 for a valid IPv4 or IPv6 address, else 0: the same answers as Node's `isIP`. */
export function ipVersion(value: string): 0 | 4 | 6 {
  if (IPV4.test(value)) return 4;
  return isIpv6(value) ? 6 : 0;
}

function isIpv6(value: string): boolean {
  // An optional zone after `%`, as in `fe80::1%eth0`.
  const zoneAt = value.indexOf('%');
  if (zoneAt !== -1 && !IPV6_ZONE.test(value.slice(zoneAt + 1))) return false;
  const address = zoneAt === -1 ? value : value.slice(0, zoneAt);

  // Eight groups, or fewer around one `::` that stands for the missing zero groups.
  const halves = address.split('::');
  if (halves.length > 2) return false;
  const compressed = halves.length === 2;
  const head = groupsOf(halves[0]);
  const tail = compressed ? groupsOf(halves[1]) : [];

  // The address's very last group may be an IPv4 address, which counts as two groups.
  const lastHalf = compressed ? tail : head;
  let count = head.length + tail.length;
  if (lastHalf.length > 0 && IPV4.test(lastHalf[lastHalf.length - 1])) {
    lastHalf.pop();
    count += 1;
  }
  if (![...head, ...tail].every((group) => IPV6_GROUP.test(group))) return false;
  return compressed ? count <= 7 : count === 8;
}

function groupsOf(part: string): string[] {
  return part === '' ? [] : part.split(':');
}
