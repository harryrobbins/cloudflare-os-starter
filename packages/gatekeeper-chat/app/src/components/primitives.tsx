// The small shared pieces: monogram avatars, count badges, presence dots, skeletons, empty states and
// the one icon-button treatment the whole app uses. Kept together because each is a dozen lines and
// splitting them would be filing, not structure.

import type { ReactNode } from "react";

import { hueFor, initials } from "../lib/format.js";

export function Avatar({
  name,
  id,
  size = 36,
  online,
  kind = "user",
}: {
  name: string;
  id: string;
  size?: number;
  online?: boolean;
  kind?: "user" | "agent";
}): ReactNode {
  const hue = hueFor(id);
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      <span
        aria-hidden="true"
        className="flex h-full w-full items-center justify-center rounded-[28%] font-semibold text-white select-none"
        style={{
          fontSize: Math.round(size * 0.38),
          background:
            kind === "agent"
              ? "linear-gradient(135deg, var(--color-kumo-brand), var(--color-kumo-brand-hover))"
              : `linear-gradient(135deg, hsl(${hue} 58% 52%), hsl(${(hue + 40) % 360} 62% 40%))`,
        }}
      >
        {initials(name)}
      </span>
      {online !== undefined && (
        <PresenceDot
          online={online}
          className="absolute -right-0.5 -bottom-0.5 ring-2 ring-kumo-base"
        />
      )}
    </span>
  );
}

export function PresenceDot({
  online,
  className = "",
  label,
}: {
  online: boolean;
  className?: string;
  label?: string;
}): ReactNode {
  return (
    <span
      // The dot is decorative beside a name that is already read out; `title` covers the pointer case.
      aria-hidden={label === undefined ? "true" : undefined}
      aria-label={label}
      title={label ?? (online ? "Online" : "Offline")}
      className={[
        "block h-2.5 w-2.5 rounded-full",
        online ? "bg-kumo-success" : "border border-kumo-interact bg-kumo-base",
        className,
      ].join(" ")}
    />
  );
}

export function CountBadge({
  count,
  tone = "solid",
  max = 99,
  className = "",
}: {
  count: number;
  tone?: "solid" | "tint";
  max?: number;
  className?: string;
}): ReactNode {
  if (count <= 0) return null;
  const toneClassName =
    tone === "solid"
      ? "bg-kumo-brand text-white"
      : "bg-kumo-brand/15 text-kumo-strong";
  return (
    <span
      data-count={count}
      className={`grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full px-1.5 text-[11px] leading-none font-semibold tabular-nums ${toneClassName} ${className}`}
    >
      {count > max ? `${max}+` : count}
    </span>
  );
}

/** The one icon-button treatment: 28px hit area, quiet at rest, tinted on hover. */
export function IconButton({
  label,
  onClick,
  children,
  active = false,
  tone = "default",
  className = "",
  ...rest
}: {
  label: string;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
  active?: boolean;
  tone?: "default" | "danger";
  className?: string;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "children">): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={active ? true : undefined}
      className={[
        "press inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors",
        tone === "danger"
          ? "text-kumo-subtle hover:bg-kumo-danger-tint hover:text-kumo-danger"
          : active
            ? "bg-kumo-fill text-kumo-brand"
            : "text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default",
        className,
      ].join(" ")}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Button({
  children,
  variant = "secondary",
  size = "md",
  className = "",
  ...rest
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
} & React.ButtonHTMLAttributes<HTMLButtonElement>): ReactNode {
  const variants: Record<string, string> = {
    primary: "bg-kumo-brand text-white hover:bg-kumo-brand-hover border-transparent",
    secondary:
      "bg-kumo-control text-kumo-default border-kumo-line hover:bg-kumo-tint hover:border-kumo-ring",
    ghost: "bg-transparent text-kumo-default border-transparent hover:bg-kumo-tint",
    danger: "bg-transparent text-kumo-danger border-kumo-line hover:bg-kumo-danger-tint",
  };
  return (
    <button
      type="button"
      className={[
        "press inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-7 px-2.5 text-[12px]" : "h-8 px-3 text-[13px]",
        variants[variant],
        className,
      ].join(" ")}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Skeleton({ className = "" }: { className?: string }): ReactNode {
  return <div aria-hidden="true" className={`chat-skeleton ${className}`} />;
}

/** The loading state for a conversation: message-shaped, so nothing reflows when the real rows land. */
export function MessageSkeletons({ rows = 6 }: { rows?: number }): ReactNode {
  return (
    <div className="flex flex-col gap-5 px-5 py-6" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex gap-3">
          <Skeleton className="h-9 w-9 rounded-[28%]" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3" />
            <Skeleton className={index % 3 === 0 ? "h-3 w-2/3" : "h-3 w-1/2"} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
}): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 py-16 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-kumo-tint text-kumo-subtle">
        {icon}
      </span>
      <div className="space-y-1">
        <p className="text-[14px] font-semibold text-kumo-strong">{title}</p>
        {body !== undefined && (
          <p className="max-w-sm text-[13px] leading-5 text-kumo-subtle">{body}</p>
        )}
      </div>
      {action}
    </div>
  );
}

export function Spinner({ size = 14, className = "" }: { size?: number; className?: string }): ReactNode {
  return (
    <span
      aria-hidden="true"
      className={`chat-spin inline-block rounded-full border-2 border-kumo-fill border-t-kumo-brand ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

export function SectionLabel({ children }: { children: ReactNode }): ReactNode {
  return (
    <span className="text-[11px] font-semibold tracking-[0.06em] text-kumo-inactive uppercase">
      {children}
    </span>
  );
}
