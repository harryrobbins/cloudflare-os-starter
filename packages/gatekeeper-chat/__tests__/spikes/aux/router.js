// Stands in for cfos-router: forwards `/gatekeeper/chat` and everything under it to the CHAT service
// binding, untouched. Mirrors cloudflare-os/packages/router/src/index.ts, including the fact that a
// WebSocket upgrade is just a request with headers -- the router does nothing special for it.
const PREFIX = "/gatekeeper/chat";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === PREFIX || url.pathname.startsWith(`${PREFIX}/`)) {
      return env.CHAT.fetch(request);
    }
    return new Response("no route", { status: 404 });
  },
};
