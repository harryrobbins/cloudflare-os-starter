// Sets the theme before the first paint so a dark-mode reload never flashes white. The app takes over
// afterwards (stored preference, then the embed bridge's `chat:theme`). A file rather than an inline
// script so the shell's Content Security Policy can be `script-src 'self'` (src/serve.ts).
(function () {
  try {
    var stored = localStorage.getItem("chat.theme");
    var mode =
      stored === "light" || stored === "dark"
        ? stored
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    document.documentElement.dataset.mode = mode;
  } catch (_) {
    /* Private mode with blocked storage: the media query default is fine. */
  }
})();
