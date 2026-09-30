import { useEffect, useState, type ReactNode } from "react";
import { Button } from "./primitives.js";

interface InstallEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** A browser-owned installation prompt, requested only by the user. Safari uses its Share menu. */
export function InstallChat(): ReactNode {
  const [prompt, setPrompt] = useState<InstallEvent | null>(null);
  const [installed, setInstalled] = useState(
    () => window.matchMedia("(display-mode: standalone)").matches,
  );
  useEffect(() => {
    const onPrompt = (event: Event): void => {
      event.preventDefault();
      setPrompt(event as InstallEvent);
    };
    const onInstalled = (): void => {
      setInstalled(true);
      setPrompt(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  // Browsers may fire before Settings mounts. The browser menu is always the fallback.
  return (
    <section>
      <h2 className="mb-3 text-[13px] font-semibold text-kumo-strong">Chat on your phone</h2>
      <div className="rounded-xl border border-kumo-line bg-kumo-elevated p-4 text-[13px] leading-6">
        <p>
          {installed
            ? "Chat is running as an installed app."
            : "Open Chat directly to add it to your home screen."}
        </p>
        <a
          className="text-kumo-link underline"
          href="/gatekeeper/chat/"
          target="_blank"
          rel="noreferrer"
        >
          Open standalone Chat
        </a>
        {!installed && (
          <p className="mt-2">
            On iPhone or iPad, use Share → Add to Home Screen and keep Open as Web App enabled if
            offered. On Android, use the browser menu → Install app or Add to Home screen.
          </p>
        )}
        {prompt !== null && !installed && (
          <Button
            className="mt-3"
            variant="primary"
            onClick={() => {
              const event = prompt;
              setPrompt(null);
              void event
                .prompt()
                .then(() => event.userChoice)
                .catch(() => undefined);
            }}
          >
            Install Chat
          </Button>
        )}
        <p className="mt-2 text-kumo-subtle">
          Sign in with your usual account. Chat needs a connection to load messages and files.
          Installation does not enable notifications while the app is closed.
        </p>
      </div>
    </section>
  );
}
