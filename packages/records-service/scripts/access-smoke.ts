/** Read-only Access boundary probe. Does not claim to establish a human OS session. */
const target = process.env.RECORDS_TEST_URL;
const id = process.env.RECORDS_CLOUDFLARE_ACCESS_CLIENT_ID;
const secret = process.env.RECORDS_CLOUDFLARE_ACCESS_CLIENT_SECRET;
if (!target || !id || !secret) throw new Error('Set RECORDS_TEST_URL, RECORDS_CLOUDFLARE_ACCESS_CLIENT_ID and RECORDS_CLOUDFLARE_ACCESS_CLIENT_SECRET in the ignored local test environment.');
const url = new URL(target);
if (url.protocol !== 'https:' || url.username || url.password) throw new Error('The remote test URL must be HTTPS without embedded credentials.');
const probe = async (authenticated: boolean) => {
  const headers = new Headers();
  if (authenticated) {
    headers.set('CF-Access-Client-Id', id);
    headers.set('CF-Access-Client-Secret', secret);
    if (process.env.RECORDS_TEST_TOKEN) headers.set('Authorization', `Bearer ${process.env.RECORDS_TEST_TOKEN}`);
  }
  // Never forward credentials across a redirect, or log cookies, headers, bodies or query strings.
  const response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  const result = { authenticated, status: response.status, contentType: response.headers.get('content-type')?.split(';')[0] ?? null };
  await response.body?.cancel(); return result;
};
const anonymous = await probe(false);
const admitted = await probe(true);
console.log(JSON.stringify({ origin: url.origin, anonymous, admitted, note: 'HTTP boundary evidence only; no human session or gadget approval is established.' }, null, 2));
if (admitted.status >= 300 || anonymous.status < 300) process.exitCode = 1;
