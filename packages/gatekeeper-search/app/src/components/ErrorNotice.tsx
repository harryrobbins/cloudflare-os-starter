import { WarningCircle } from "@phosphor-icons/react";
import type { ReactNode } from "react";

import { describeError } from "../api/client.js";

/** An error from the API, inline. A 401 offers a reload, which sends the browser through Access. */
export function ErrorNotice({
  error,
  onRetry,
  compact = false,
}: {
  error: unknown;
  onRetry?: () => void;
  compact?: boolean;
}): ReactNode {
  const { message, signIn } = describeError(error);
  return (
    <div
      role="alert"
      className={`flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-tint text-sm text-danger ${compact ? "px-3 py-2" : "px-4 py-3"}`}
    >
      <WarningCircle size={18} weight="bold" className="mt-0.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-fg">{message}</p>
        {signIn ? (
          <a
            href={typeof window === "undefined" ? "." : window.location.href}
            className="mt-1 inline-block font-medium text-link underline underline-offset-2"
          >
            Sign in again
          </a>
        ) : onRetry !== undefined ? (
          <button
            type="button"
            onClick={onRetry}
            className="mt-1 cursor-pointer font-medium text-link underline underline-offset-2"
          >
            Try again
          </button>
        ) : null}
      </div>
    </div>
  );
}
