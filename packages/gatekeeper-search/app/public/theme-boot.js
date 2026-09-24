// Sets the theme before the first paint so a dark-mode reload never flashes white. The app follows the
// system theme; src/main.tsx keeps `data-mode` in step when it changes. A file rather than an inline
// script so the Content Security Policy can stay `script-src 'self'`.
(function () {
  try {
    var dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.mode = dark ? "dark" : "light";
  } catch (_) {
    /* No matchMedia: light is fine. */
  }
})();
