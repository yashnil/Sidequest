import { NextResponse } from 'next/server';
import { guardAction } from '@/lib/net/caller';

/**
 * V8 §1.9 — A PAGE FAILURE IN THE BROWSER, TIED TO ONE SERVER LOG LINE.
 *
 * A server-rendered fault already carries a digest that matches the server
 * log. A fault that happens in the browser — a dropped request, a client
 * render error — has no server record at all, so the reference a traveller is
 * shown would point at nothing. The boundary posts it here (best-effort, by
 * beacon) and one structured line is written under that reference.
 *
 * Deliberately tiny: a short reference, a route, an error name and a capped
 * message; no cookies are read, nothing is stored, and the fence bounds it.
 */
export const dynamic = 'force-dynamic';

const MAX_BYTES = 2_048;

export async function POST(request: Request): Promise<NextResponse> {
  const fence = await guardAction('client_failure_report');
  if (fence) return NextResponse.json({ ok: false }, { status: 429 });
  const text = await request.text().catch(() => '');
  if (text.length === 0 || text.length > MAX_BYTES) return NextResponse.json({ ok: false }, { status: 400 });
  let body: { ref?: unknown; route?: unknown; name?: unknown; message?: unknown; digest?: unknown };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const ref = typeof body.ref === 'string' && /^[A-Za-z0-9_-]{4,16}$/.test(body.ref) ? body.ref : null;
  if (!ref) return NextResponse.json({ ok: false }, { status: 400 });
  console.error('Client route failed', {
    ref,
    route: typeof body.route === 'string' ? body.route.slice(0, 120) : null,
    name: typeof body.name === 'string' ? body.name.slice(0, 60) : null,
    message: typeof body.message === 'string' ? body.message.slice(0, 200) : null,
    digest: typeof body.digest === 'string' ? body.digest.slice(0, 60) : null,
  });
  return NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
}
