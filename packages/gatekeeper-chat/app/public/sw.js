// Only an offline navigation fallback. Never cache Access responses, messages or files.
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request).catch(() => new Response(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chat is offline</title><body><main><h1>Chat is offline</h1>
<p>Connect to the internet, then reopen Chat. Messages and files need a connection.</p>
<a href="/gatekeeper/chat/">Try again</a></main></body></html>`, {
    status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  })));
});
