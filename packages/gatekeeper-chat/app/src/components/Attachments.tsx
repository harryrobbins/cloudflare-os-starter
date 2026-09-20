// Attachments: images inline with a lightbox, everything else as a file card.

import { DownloadSimple, FileText, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import type { Attachment } from "../contract.js";
import { formatBytes } from "../lib/format.js";
import { fileUrl, isInlineImage } from "../lib/files.js";
import { IconButton } from "./primitives.js";

export function Attachments({ attachments }: { attachments: readonly Attachment[] }): ReactNode {
  const [lightbox, setLightbox] = useState<Attachment | null>(null);
  if (attachments.length === 0) return null;
  const images = attachments.filter((attachment) => isInlineImage(attachment.mime));
  const files = attachments.filter((attachment) => !isInlineImage(attachment.mime));

  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((attachment) => (
            <button
              key={attachment.id}
              type="button"
              onClick={() => setLightbox(attachment)}
              // A caption is not guaranteed, so the file name is the accessible name.
              aria-label={`Open ${attachment.name}`}
              className="press group relative block cursor-zoom-in overflow-hidden rounded-lg border border-kumo-line bg-kumo-elevated"
            >
              <img
                src={fileUrl(attachment.id, attachment.hasThumb)}
                alt={attachment.name}
                width={attachment.width ?? undefined}
                height={attachment.height ?? undefined}
                loading="lazy"
                decoding="async"
                // Capped both ways: by height so a portrait and a landscape image sit on the same
                // line tidily, and by width so a wide screenshot does not become the whole message.
                className="block max-h-64 w-auto max-w-full object-cover sm:max-w-[26rem]"
                style={aspectStyle(attachment)}
              />
            </button>
          ))}
        </div>
      )}
      {files.map((attachment) => (
        <a
          key={attachment.id}
          href={fileUrl(attachment.id)}
          download={attachment.name}
          className="group flex w-full max-w-sm items-center gap-3 rounded-lg border border-kumo-line bg-kumo-elevated px-3 py-2.5 transition-colors hover:border-kumo-ring hover:bg-kumo-tint"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-kumo-fill text-kumo-subtle">
            <FileText size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-kumo-strong">
              {attachment.name}
            </span>
            <span className="block text-[11px] text-kumo-subtle">
              {formatBytes(attachment.bytes)}
            </span>
          </span>
          <DownloadSimple
            size={16}
            className="shrink-0 text-kumo-inactive transition-colors group-hover:text-kumo-brand"
          />
        </a>
      ))}
      {lightbox !== null && <Lightbox attachment={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

/** Reserves the image's box before it loads, so the list does not jump as pictures arrive. */
function aspectStyle(attachment: Attachment): React.CSSProperties | undefined {
  if (attachment.width === null || attachment.height === null) return undefined;
  return { aspectRatio: `${attachment.width} / ${attachment.height}` };
}

function Lightbox({
  attachment,
  onClose,
}: {
  attachment: Attachment;
  onClose: () => void;
}): ReactNode {
  const handleKey = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [handleKey]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={attachment.name}
      className="fixed inset-0 z-[1300] flex flex-col bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3 text-white">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium">{attachment.name}</p>
          <p className="text-[11px] text-white/60">{formatBytes(attachment.bytes)}</p>
        </div>
        <div className="flex items-center gap-1">
          <a
            href={fileUrl(attachment.id)}
            download={attachment.name}
            onClick={(event) => event.stopPropagation()}
            aria-label={`Download ${attachment.name}`}
            className="press inline-flex h-7 w-7 items-center justify-center rounded-md text-white/80 hover:bg-white/10 hover:text-white"
          >
            <DownloadSimple size={16} />
          </a>
          <IconButton label="Close" onClick={onClose} className="text-white/80 hover:bg-white/10 hover:text-white">
            <X size={16} />
          </IconButton>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        <img
          src={fileUrl(attachment.id)}
          alt={attachment.name}
          onClick={(event) => event.stopPropagation()}
          className="max-h-full max-w-full rounded-lg object-contain"
        />
      </div>
    </div>
  );
}
