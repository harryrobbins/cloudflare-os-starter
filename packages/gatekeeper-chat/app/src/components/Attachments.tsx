// Attachments: images inline with a lightbox, everything else as a file card.

import { CaretLeft, CaretRight, DownloadSimple, FileText, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { Attachment } from "../contract.js";
import { formatBytes } from "../lib/format.js";
import { fileUrl, isInlineImage } from "../lib/files.js";
import { IconButton } from "./primitives.js";

export function Attachments({ attachments }: { attachments: readonly Attachment[] }): ReactNode {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  if (attachments.length === 0) return null;
  const images = attachments.filter((attachment) => isInlineImage(attachment.mime));
  const files = attachments.filter((attachment) => !isInlineImage(attachment.mime));

  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {images.length > 0 && (
        // `items-start`: a flex row stretches its children, which letterboxes a short image next to
        // a tall one inside its own bordered box.
        <div className="flex flex-wrap items-start gap-2">
          {images.map((attachment, index) => (
            <Thumbnail
              key={attachment.id}
              attachment={attachment}
              onOpen={() => setLightboxIndex(index)}
            />
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
      {lightboxIndex !== null && images[lightboxIndex] !== undefined && (
        <Lightbox
          images={images}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
}

/**
 * One inline image.
 *
 * The box is reserved before the bytes arrive -- from the attachment's own dimensions when the server
 * sniffed them, and from a plain 16:10 guess when it did not -- and a shimmer fills it until `load`
 * fires. Reserving is what stops the conversation shifting under the reader as pictures resolve; the
 * shimmer is what stops the reserved box looking like a rendering fault while it is empty.
 */
function Thumbnail({
  attachment,
  onOpen,
}: {
  attachment: Attachment;
  onOpen: () => void;
}): ReactNode {
  const [loaded, setLoaded] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);

  // A cached image can complete before React attaches the handler, which would leave the shimmer up
  // for ever. The ref callback asks the element directly.
  useEffect(() => {
    if (imageRef.current?.complete === true) setLoaded(true);
  }, []);

  return (
    <button
      type="button"
      onClick={onOpen}
      // A caption is not guaranteed, so the file name is the accessible name.
      aria-label={`Open ${attachment.name}`}
      className="press group relative block cursor-zoom-in overflow-hidden rounded-lg border border-kumo-line bg-kumo-elevated"
      style={boxStyle(attachment, loaded)}
    >
      {!loaded && <span aria-hidden="true" className="chat-skeleton absolute inset-0 rounded-none" />}
      <img
        ref={imageRef}
        src={fileUrl(attachment.id, attachment.hasThumb)}
        alt={attachment.name}
        width={attachment.width ?? undefined}
        height={attachment.height ?? undefined}
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        // A broken image should not shimmer for ever either.
        onError={() => setLoaded(true)}
        // Capped both ways: by height so a portrait and a landscape image sit on the same
        // line tidily, and by width so a wide screenshot does not become the whole message.
        className={[
          "relative block max-h-64 w-auto max-w-full object-cover transition-opacity duration-200 sm:max-w-[26rem]",
          loaded ? "opacity-100" : "opacity-0",
        ].join(" ")}
        style={aspectStyle(attachment)}
      />
    </button>
  );
}

/** Reserves the image's box before it loads, so the list does not jump as pictures arrive. */
function aspectStyle(attachment: Attachment): React.CSSProperties | undefined {
  if (attachment.width === null || attachment.height === null) return undefined;
  return { aspectRatio: `${attachment.width} / ${attachment.height}` };
}

/**
 * The placeholder box, used only while the image is still arriving.
 *
 * Needed for the case the server could not measure: with no `aspectRatio` on the `<img>` the button
 * would be zero-height, so the shimmer would be invisible and the row would jump anyway. The guess is
 * dropped the instant the real image is there, so a wrong guess costs one reflow rather than a
 * permanently mis-shaped picture.
 */
function boxStyle(attachment: Attachment, loaded: boolean): React.CSSProperties | undefined {
  if (loaded || attachment.width !== null) return undefined;
  return { aspectRatio: "16 / 10", width: "min(26rem, 100%)", maxHeight: "16rem" };
}

function Lightbox({
  images,
  index,
  onIndexChange,
  onClose,
}: {
  images: readonly Attachment[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}): ReactNode {
  const attachment = images[index]!;
  const many = images.length > 1;

  /** Escape closes; the arrows walk the message's images; Home and End jump to the ends. */
  const handleKey = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (!many) return;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        onIndexChange((index + 1) % images.length);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        onIndexChange((index - 1 + images.length) % images.length);
      } else if (event.key === "Home") {
        event.preventDefault();
        onIndexChange(0);
      } else if (event.key === "End") {
        event.preventDefault();
        onIndexChange(images.length - 1);
      }
    },
    [onClose, onIndexChange, index, images.length, many],
  );

  useEffect(() => {
    // Capture, so Escape closes the lightbox rather than the thread pane underneath it.
    document.addEventListener("keydown", handleKey, true);
    return () => document.removeEventListener("keydown", handleKey, true);
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
          <p className="text-[11px] text-white/60">
            {formatBytes(attachment.bytes)}
            {many && ` · ${index + 1} of ${images.length}`}
          </p>
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
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 p-4">
        {many && (
          <IconButton
            label="Previous image"
            onClick={(event) => {
              event.stopPropagation();
              onIndexChange((index - 1 + images.length) % images.length);
            }}
            className="h-10 w-10 shrink-0 text-white/80 hover:bg-white/10 hover:text-white"
          >
            <CaretLeft size={20} />
          </IconButton>
        )}
        <img
          key={attachment.id}
          src={fileUrl(attachment.id)}
          alt={attachment.name}
          onClick={(event) => event.stopPropagation()}
          className="max-h-full max-w-full rounded-lg object-contain"
        />
        {many && (
          <IconButton
            label="Next image"
            onClick={(event) => {
              event.stopPropagation();
              onIndexChange((index + 1) % images.length);
            }}
            className="h-10 w-10 shrink-0 text-white/80 hover:bg-white/10 hover:text-white"
          >
            <CaretRight size={20} />
          </IconButton>
        )}
      </div>
      {many && (
        <p className="pb-3 text-center text-[11px] text-white/50">
          Use ← and → to move between images, Esc to close.
        </p>
      )}
    </div>
  );
}
