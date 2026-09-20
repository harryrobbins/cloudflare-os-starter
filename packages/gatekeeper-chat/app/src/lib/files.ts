// Attachment URLs.
//
// The real URL always comes from `filePath()`. The indirection exists for one reason: the mock
// transport has no R2 and no `/files/` route, so it registers a resolver that hands back inline data
// URLs instead. Production never installs one, so `fileUrl` is `filePath` with an extra call frame.

import { filePath } from "../contract.js";

type Resolver = (attachmentId: string, thumb: boolean) => string | null;

let resolver: Resolver | null = null;

export function setFileUrlResolver(next: Resolver | null): void {
  resolver = next;
}

export function fileUrl(attachmentId: string, thumb = false): string {
  return resolver?.(attachmentId, thumb) ?? filePath(attachmentId, thumb);
}

/** Whether an attachment renders inline. Images only, and only the formats a browser will show. */
export function isInlineImage(mime: string): boolean {
  return /^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/.test(mime);
}
