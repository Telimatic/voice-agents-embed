// @vitest-environment node
//
// TLZ-754. The app reaches no cache, database, ClickHouse or object storage itself (its one
// server route mints a LiveKit token locally), so /healthz has no checks: it proves the
// process serves requests. There is no middleware, so nothing else gates the path.
import { describe, expect, it } from 'vitest';
import { GET, HEAD } from '../route';

describe('/healthz', () => {
  it('GET answers 200 with the exact contract body and no-store', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).toBe('{"status":"ok","checks":{}}');
  });

  it('HEAD answers 200 with no body and no-store', async () => {
    const res = await HEAD();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body).toBeNull();
  });
});
