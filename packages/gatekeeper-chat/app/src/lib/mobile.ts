/** Track the visible screen without disabling pinch zoom. Top-level only: dock frames own their size. */
export function trackMobileViewport(): () => void {
  if (window.self !== window.top || window.visualViewport === null) return () => undefined;
  const viewport = window.visualViewport;
  function update(): void {
    // Pinch zoom should retain browser panning, rather than resizing the app underneath the user.
    if (viewport === null || Math.abs(viewport.scale - 1) > 0.05) return;
    const style = document.documentElement.style;
    style.setProperty("--chat-height", `${viewport.height}px`);
    style.setProperty("--chat-top", `${viewport.offsetTop}px`);
    document.documentElement.dataset.keyboard =
      window.innerHeight - viewport.height > 120 ? "1" : "0";
  }
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  window.addEventListener("resize", update);
  update();
  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
    window.removeEventListener("resize", update);
    document.documentElement.style.removeProperty("--chat-height");
    document.documentElement.style.removeProperty("--chat-top");
    delete document.documentElement.dataset.keyboard;
  };
}
