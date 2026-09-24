// An in-process fixed-window rate limit per key (the Workers rate limiter's role on Node). Per
// instance: N instances allow up to N × limit, as the Workers limiter is per location.

export function fixedWindowLimiter({ limit, windowMs }: { limit: number; windowMs: number }): (key: string) => boolean {
  const windows = new Map<string, { start: number; count: number }>();
  let lastSweep = Date.now();
  return (key) => {
    const now = Date.now();
    if (now - lastSweep > windowMs) {
      for (const [k, w] of windows) if (now - w.start >= windowMs) windows.delete(k);
      lastSweep = now;
    }
    const w = windows.get(key);
    if (!w || now - w.start >= windowMs) {
      windows.set(key, { start: now, count: 1 });
      return true;
    }
    w.count++;
    return w.count <= limit;
  };
}
