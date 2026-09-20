// Settings: the display-name override, the notification opt-in, and the theme.
//
// The display name is an override, never a prompt: identity comes from Access, and "nobody is invited,
// approved or asked for a name". It exists only because the IdP may not supply a useful one.
//
// The notification permission is requested here and nowhere else, from this button's click, because an
// unprompted `Notification.requestPermission()` on load is both rude and penalised by browsers.

import { Bell, Moon, Sun, Desktop } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";

import { MAX_DISPLAY_NAME_LENGTH } from "../contract.js";
import { useChat, useStore } from "../hooks/store.js";
import { Avatar, Button } from "../components/primitives.js";
import { ViewShell } from "./ViewShell.js";

export function SettingsView({ onBack }: { onBack?: () => void }): ReactNode {
  const store = useStore();
  const me = useChat((state) => state.me);
  const prefs = useChat((state) => state.prefs);
  const themeOverride = useChat((state) => state.themeOverride);
  const optedIn = useChat((state) => state.notificationsOptIn);
  const permission = useChat((state) => state.notificationPermission);
  const admin = useChat((state) => state.admin);
  const [name, setName] = useState(prefs.displayName ?? "");

  return (
    <ViewShell title="Settings" {...(onBack === undefined ? {} : { onBack })}>
      <div className="mx-auto flex max-w-xl flex-col gap-8 p-5">
        <section>
          <h2 className="mb-3 text-[13px] font-semibold text-kumo-strong">You</h2>
          <div className="flex items-center gap-3 rounded-xl border border-kumo-line bg-kumo-elevated p-4">
            {me !== null && <Avatar name={me.name} id={me.id} size={44} online />}
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-kumo-strong">{me?.name ?? ""}</p>
              <p className="truncate text-[12px] text-kumo-subtle">{me?.email ?? ""}</p>
            </div>
            {admin && (
              <span className="rounded-full bg-kumo-brand/15 px-2 py-0.5 text-[11px] font-semibold text-kumo-brand">
                admin
              </span>
            )}
          </div>

          <label className="mt-4 block">
            <span className="mb-1 block text-[12px] font-medium text-kumo-default">
              Display name override
            </span>
            <span className="mb-2 block text-[11px] text-kumo-subtle">
              Your name comes from your sign-in. Set this only if it is wrong or missing.
            </span>
            <span className="flex gap-2">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={MAX_DISPLAY_NAME_LENGTH}
                placeholder={me?.name ?? "Your name"}
                className="flex-1 rounded-lg border border-kumo-line bg-kumo-control px-2.5 py-2 text-[13px] text-kumo-default outline-none focus:border-kumo-brand placeholder:text-kumo-inactive"
              />
              <Button
                variant="primary"
                onClick={() => void store.updatePrefs({ displayName: name.trim().length === 0 ? null : name.trim() })}
              >
                Save
              </Button>
            </span>
          </label>
        </section>

        <section>
          <h2 className="mb-3 text-[13px] font-semibold text-kumo-strong">Notifications</h2>
          <div className="flex items-start gap-3 rounded-xl border border-kumo-line bg-kumo-elevated p-4">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-kumo-tint text-kumo-subtle">
              <Bell size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-kumo-strong">Browser notifications</p>
              <p className="mt-0.5 text-[12px] leading-5 text-kumo-subtle">
                {permission === "unsupported"
                  ? "This browser does not support notifications."
                  : permission === "denied"
                    ? "Blocked for this site. Allow notifications in your browser settings to turn them on."
                    : "Shown only while this tab is in the background, for conversations you have not muted. We ask the browser for permission when you turn this on, not before."}
              </p>
            </div>
            <Button
              variant={optedIn ? "secondary" : "primary"}
              disabled={permission === "unsupported" || permission === "denied"}
              onClick={() => (optedIn ? store.disableNotifications() : void store.enableNotifications())}
            >
              {optedIn ? "Turn off" : "Turn on"}
            </Button>
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-[13px] font-semibold text-kumo-strong">Appearance</h2>
          <div className="flex gap-2">
            {(
              [
                { value: null, label: "System", icon: <Desktop size={15} /> },
                { value: "light" as const, label: "Light", icon: <Sun size={15} /> },
                { value: "dark" as const, label: "Dark", icon: <Moon size={15} /> },
              ]
            ).map((option) => (
              <button
                key={option.label}
                type="button"
                onClick={() => store.setTheme(option.value)}
                aria-pressed={themeOverride === option.value}
                className={[
                  "press flex flex-1 cursor-pointer flex-col items-center gap-1.5 rounded-xl border p-4 text-[12px] transition-colors",
                  themeOverride === option.value
                    ? "border-kumo-brand bg-kumo-brand/5 text-kumo-brand"
                    : "border-kumo-line text-kumo-subtle hover:border-kumo-ring hover:text-kumo-default",
                ].join(" ")}
              >
                {option.icon}
                {option.label}
              </button>
            ))}
          </div>
        </section>
      </div>
    </ViewShell>
  );
}
