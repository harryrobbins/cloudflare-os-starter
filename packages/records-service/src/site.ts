import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const types: Record<string, string> = {
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2',
};
const publishedPlans = new Set(['/architecture-plan.md', '/blueprint-adaptation-plan.md', '/explorer-blueprint-plan.md']);
export type SiteHandler = (request: Request) => Response | null;

/** Load only publishable assets once; requests never turn URL paths into filesystem reads. */
export async function loadSite(directory: string): Promise<SiteHandler> {
  const root = resolve(directory);
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('RECORDS_SITE_DIR must be a real directory');
  const assets = new Map<string, { bytes: Uint8Array; type: string }>();
  const directories = new Set<string>();
  let total = 0;
  async function scan(path: string, prefix: string): Promise<void> {
    for (const item of await readdir(path, { withFileTypes: true })) {
      if (item.name.startsWith('.') || item.isSymbolicLink()) continue;
      const relative = `${prefix}/${item.name}`;
      // API paths remain exclusively owned by the API even if a site tree contains matching files.
      if (relative === '/v1' || relative.startsWith('/v1/') || relative === '/healthz') continue;
      if (item.isDirectory()) { await scan(join(path, item.name), relative); continue; }
      if (!item.isFile()) continue;
      const extension = item.name.split('.').at(-1)?.toLowerCase() ?? '';
      const type = publishedPlans.has(relative) ? 'text/markdown; charset=utf-8' : types[extension]; if (!type) continue;
      const metadata = await lstat(join(path, item.name));
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      if (metadata.size + total > 32 * 1024 * 1024) throw new Error('Records site exceeds static asset limit');
      const bytes = new Uint8Array(await readFile(join(path, item.name)));
      total += bytes.length;
      if (assets.size >= 4096 || total > 32 * 1024 * 1024) throw new Error('Records site exceeds static asset limit');
      assets.set(relative, { bytes, type });
      if (item.name === 'index.html') {
        if (prefix) { directories.add(prefix); assets.set(`${prefix}/`, { bytes, type }); }
        else assets.set('/', { bytes, type });
      }
    }
  }
  await scan(root, '');
  if (!assets.has('/')) throw new Error('Records site needs an index.html');
  return request => {
    const url = new URL(request.url);
    const pathname = url.pathname;
    if (pathname === '/v1' || pathname.startsWith('/v1/') || pathname === '/healthz') return null;
    if (directories.has(pathname) && (request.method === 'GET' || request.method === 'HEAD')) {
      return new Response(null, { status: 308, headers: { location: `${pathname}/${url.search}` } });
    }
    // No percent decoding, path joining, directory listing or SPA fallback occurs at request time.
    const asset = assets.get(pathname);
    if (!asset) return null;
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD', 'cache-control': 'no-store' } });
    return new Response(request.method === 'HEAD' ? null : asset.bytes.slice(), {
      headers: {
        'content-type': asset.type, 'content-length': String(asset.bytes.length),
        'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff',
        'referrer-policy': 'strict-origin-when-cross-origin',
      },
    });
  };
}
