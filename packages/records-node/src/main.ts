// Run the Records service from environment variables (bin/records-node.mjs calls this).
//
//   RECORDS_DATABASE_URL      required; the runtime login (member of records_app)
//   RECORDS_PORT | PORT       default 8788
//   RECORDS_HOST              default 127.0.0.1
//   RECORDS_PUBLIC_BASE_URL   the public origin (request URLs, OpenAPI server)
//   RECORDS_ACCESS_ISSUER     Cloudflare Access team URL, with RECORDS_ACCESS_AUDIENCE: verify the
//   RECORDS_ACCESS_AUDIENCE   Access assertion as the Worker does
//   RECORDS_ACCESS=none       or: no first factor (the Records credential alone); must be explicit
//   RECORDS_POOL_SIZE         default 10
//   RECORDS_RATE_LIMIT        requests per credential per minute (default 600; 0 disables)
//   RECORDS_POKE_PUBSUB       memory (default) | postgres (LISTEN/NOTIFY between instances)

import { createRecordsServer, type RecordsServer } from "./server.js";

export async function startFromEnv(env: Record<string, string | undefined> = process.env): Promise<{ server: RecordsServer; url: string }> {
  const databaseUrl = env.RECORDS_DATABASE_URL;
  if (!databaseUrl) throw new Error("RECORDS_DATABASE_URL is required.");
  let access: { issuer: string; audience: string } | "none";
  if (env.RECORDS_ACCESS === "none") access = "none";
  else if (env.RECORDS_ACCESS_ISSUER && env.RECORDS_ACCESS_AUDIENCE) access = { issuer: env.RECORDS_ACCESS_ISSUER, audience: env.RECORDS_ACCESS_AUDIENCE };
  else throw new Error("Set RECORDS_ACCESS_ISSUER and RECORDS_ACCESS_AUDIENCE, or RECORDS_ACCESS=none.");
  const perMinute = env.RECORDS_RATE_LIMIT === undefined ? 600 : Number(env.RECORDS_RATE_LIMIT);
  if (!Number.isFinite(perMinute) || perMinute < 0) throw new Error("RECORDS_RATE_LIMIT must be a number of requests per minute.");
  const pubsub = env.RECORDS_POKE_PUBSUB === "postgres" ? "postgres" : "memory";

  const server = await createRecordsServer({
    databaseUrl,
    access,
    poolSize: env.RECORDS_POOL_SIZE ? Number(env.RECORDS_POOL_SIZE) : 10,
    ...(env.RECORDS_PUBLIC_BASE_URL ? { publicBaseUrl: env.RECORDS_PUBLIC_BASE_URL } : {}),
    rateLimit: perMinute === 0 ? false : { limit: perMinute, windowMs: 60_000 },
    pokes: { pubsub },
  });
  const url = await server.listen(Number(env.RECORDS_PORT ?? env.PORT ?? 8788), env.RECORDS_HOST ?? "127.0.0.1");
  return { server, url };
}
