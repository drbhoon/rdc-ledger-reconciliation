import { NextResponse, type NextRequest } from 'next/server';

/**
 * The admin console is behind HTTP Basic auth using credentials held only in
 * Railway's environment (ADMIN_USERNAME / ADMIN_PASSWORD). Basic auth is
 * adequate here because Railway terminates TLS, the console is read-only, and
 * it keeps the app free of a session store.
 *
 * If the credentials are not configured the console is CLOSED, not open — an
 * unconfigured deployment must never expose it.
 */
const PROTECTED = /^\/(admin|api\/admin)(\/|$)/;

/** Constant-time compare so a wrong password cannot be found byte by byte. */
function safeEqual(a: string, b: string) {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  // Compare a fixed number of bytes regardless of length.
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

const challenge = (message: string) =>
  new NextResponse(message, {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="RDC Reconciliation Admin", charset="UTF-8"' },
  });

export function middleware(request: NextRequest) {
  if (!PROTECTED.test(request.nextUrl.pathname)) return NextResponse.next();

  const user = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!user || !password) {
    return new NextResponse(
      'Admin console is not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD in the Railway service variables.',
      { status: 503 },
    );
  }

  const header = request.headers.get('authorization') || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return challenge('Authentication required.');

  let decoded = '';
  try {
    decoded = atob(encoded);
  } catch {
    return challenge('Malformed credentials.');
  }
  const separator = decoded.indexOf(':');
  const givenUser = separator >= 0 ? decoded.slice(0, separator) : '';
  const givenPassword = separator >= 0 ? decoded.slice(separator + 1) : '';

  // Both compared every time — never short-circuit on the username.
  const ok = safeEqual(givenUser, user) && safeEqual(givenPassword, password);
  if (!ok) {
    console.warn('[admin] rejected sign-in attempt');
    return challenge('Invalid credentials.');
  }
  return NextResponse.next();
}

export const config = { matcher: ['/admin/:path*', '/api/admin/:path*'] };
