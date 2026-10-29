import { NextResponse } from 'next/server';

// TLZ-754 /healthz contract. This app reaches no cache, database, ClickHouse or object
// storage itself, so there is nothing to check: answering proves the process serves
// requests. Third-party APIs (LiveKit, the remote app config) are deliberately not checked.
export const dynamic = 'force-dynamic';

const HEADERS = { 'Cache-Control': 'no-store' };

export async function GET() {
  return NextResponse.json({ status: 'ok', checks: {} }, { headers: HEADERS });
}

export async function HEAD() {
  return new NextResponse(null, { headers: HEADERS });
}
