/** Secrets are separate from generated public Wrangler variables and never forwarded from the caller. */
export type EdgeEnvironment = Env & { CF_ACCESS_CLIENT_ID?: string; CF_ACCESS_CLIENT_SECRET?: string };
function problem(status: number, title: string): Response {
  return Response.json({ type: 'about:blank', title, status }, { status, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' } });
}
function originFor(env: EdgeEnvironment): URL | null {
  try {
    const origin = new URL(env.RECORDS_ORIGIN);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return null;
    if (!['access', 'records'].includes(env.ORIGIN_AUTH_MODE)) return null;
    if (env.ORIGIN_AUTH_MODE === 'access' && (!env.CF_ACCESS_CLIENT_ID || !env.CF_ACCESS_CLIENT_SECRET)) return null;
    return origin;
  } catch { return null; }
}
function route(path: string): 'GET' | 'POST' | null {
  if (path === '/healthz' || path === '/v1/openapi.json') return 'GET';
  if (/^\/v1\/vocabulary\/schemaorg\/terms\/[A-Za-z][A-Za-z0-9]*$/.test(path)) return 'GET';
  if (/^\/v1\/models\/[a-z][a-z0-9_-]{0,62}(?:\/v[1-9]\d{0,3})?(?:\/profile|\/schema\/[a-z][a-z0-9_]{0,62})?$/.test(path)) return 'GET';
  const base = /^\/v1\/datastores\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(.*)$/i.exec(path);
  if (!base) return null;
  if (/^(changes|describe|events|openapi)$/.test(base[1]!)) return 'GET';
  if (/^modules\/[a-z][a-z0-9_-]{0,62}\/v[1-9]\d{0,3}\/(records|snapshot)$/.test(base[1]!)) return 'GET';
  if (/^modules\/[a-z][a-z0-9_-]{0,62}\/v[1-9]\d{0,3}\/rpc\/[a-z][a-z0-9_.-]{0,127}$/.test(base[1]!)) return 'POST';
  return null;
}
/** Streams both directions. Origin remains fixed by operator configuration, never request parameters. */
export async function proxyRecords(request: Request, env: EdgeEnvironment, transport: typeof fetch = fetch): Promise<Response> {
  const origin = originFor(env);
  if (!origin) return problem(503, 'Records origin is not configured');
  const incoming = new URL(request.url);
  if (incoming.origin === origin.origin) return problem(503, 'Records origin would create a routing loop');
  const method = route(incoming.pathname);
  if (!method) return problem(404, 'Route not found');
  if (request.method !== method) return problem(405, 'Method not allowed');
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > 65536)) return problem(413, 'Request too large');
  const headers = new Headers();
  for (const name of ['authorization', 'content-type', 'accept', 'idempotency-key', 'if-match']) {
    const value = request.headers.get(name); if (value !== null) headers.set(name, value);
  }
  if ((headers.get('authorization')?.length ?? 0) > 2048) return problem(401, 'Invalid credentials');
  if (env.ORIGIN_AUTH_MODE === 'access') {
    headers.set('CF-Access-Client-Id', env.CF_ACCESS_CLIENT_ID!);
    headers.set('CF-Access-Client-Secret', env.CF_ACCESS_CLIENT_SECRET!);
  }
  const target = new URL(incoming.pathname + incoming.search, origin);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 15000);
  try {
    const response = await transport(target, {
      method, headers, redirect: 'manual',
      ...(method === 'POST' ? { body: request.body, duplex: 'half' } : {}),
      // Streaming requests remain bound to caller cancellation; origin headers have a bounded wait.
      signal: AbortSignal.any([request.signal, deadline.signal]),
    });
    clearTimeout(timer);
    // Worker fetch can forward credentials across redirects. Never follow or expose origin redirects.
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return problem(502, 'Records origin redirected unexpectedly'); }
    const type = response.headers.get('content-type')?.split(';')[0]?.trim();
    if (!['application/json', 'application/problem+json', 'application/ld+json', 'text/event-stream'].includes(type ?? '')) {
      await response.body?.cancel(); return problem(502, 'Records origin returned an unexpected response');
    }
    const resultHeaders = new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    for (const name of ['content-type', 'etag', 'retry-after']) { const value = response.headers.get(name); if (value !== null) resultHeaders.set(name, value); }
    return new Response(response.body, { status: response.status, headers: resultHeaders });
  } catch { return problem(502, 'Records origin is unavailable'); }
  finally { clearTimeout(timer); }
}
export default { fetch(request: Request, env: EdgeEnvironment) { return proxyRecords(request, env); } } satisfies ExportedHandler<EdgeEnvironment>;
