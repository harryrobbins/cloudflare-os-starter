# Blueprint thumbnails and screenshots in Cloudflare OS

Code trace and architecture analysis of blueprint thumbnails and preview placeholders in Cloudflare OS. Written 2026-09-17 against the pinned submodule at `cloudflare-os` commit `90f0591` and repository formats in `formats/`. Paths are relative to `cloudflare-os/` unless prefixed with repository root paths.

---

## Headline

Cloudflare OS **does** have a mechanism to define and display thumbnail images ("screenshots") for blueprints, but **only for user-created / published blueprints**.

For **bundled format blueprints** (such as Docs, Sheets, Slides, Board, Notebook, Whiteboard) and **imported `.gadget` archives**, there is currently **no mechanism** to define or bundle a thumbnail. Because bundled formats lack screenshot data, they all fall back to the frontend's static wireframe placeholder ([`BlueprintPreviewPlaceholder`](packages/workshop-frontend/src/components/BlueprintPreviewImage.tsx:31-59)), which is why they appear identical.

---

## 1. User-created blueprints (supported path)

When a blueprint is created or edited from an active workspace in the gadget editor, authors can upload a custom thumbnail image directly through the UI.

### Frontend upload flow

- **UI Form**: In [`packages/workshop-frontend/src/BlueprintModal.tsx:338-385`](packages/workshop-frontend/src/BlueprintModal.tsx), the blueprint creation and edit dialog provides an optional **Screenshot** file input accepting `image/*`.
- **Client-side compression**: When a user selects an image, [`compressBlueprintScreenshot()`](packages/workshop-frontend/src/BlueprintModal.tsx:18-58) processes the file before upload:
  - Draws the image to a `<canvas>` element sized to 1280×720 (16:9 aspect ratio, cover-fit).
  - Iteratively compresses the canvas to `image/jpeg` targeting under 700 KB (`MAX_BLUEPRINT_SCREENSHOT_BYTES = 700 * 1024`).
- **Submission**: On submit, the JPEG bytes are sent over RPC via `BlueprintScreenshotUpload`:
  ```ts
  // packages/workshop-shared/src/api.ts:3181-3184
  export type BlueprintScreenshotUpload = {
    mimeType: "image/jpeg" | "image/png";
    content: Uint8Array;
  };
  ```
  - `gadget.createBlueprint(title, description, screenshot)` (`BlueprintModal.tsx:203-207`)
  - `overseer.updateBlueprint(id, { title, description, updateBindings, screenshot })` (`BlueprintModal.tsx:241-246`)

### Backend storage and propagation

- **Overseer validation**: [`packages/workshop-backend/src/overseer.ts:462-470`](packages/workshop-backend/src/overseer.ts) enforces a strict server-side ceiling of 1 MiB (`MAX_BLUEPRINT_SCREENSHOT_BYTES = 1024 * 1024`).
- **Storage in R2**:
  - Image bytes are stored in the `BLUEPRINT_CONTENT` R2 bucket under the key prefix `screenshots/<blueprintId>`:
    ```ts
    // packages/workshop-backend/src/overseer.ts:5257-5262
    await this.env.BLUEPRINT_CONTENT.put(
      `${BLUEPRINT_SCREENSHOT_R2_PREFIX}${record.id}`,
      screenshot.content,
      { httpMetadata: { contentType: screenshot.mimeType } }
    );
    ```
- **Metadata flag**: The metadata object records only a boolean marker:
  ```ts
  // packages/workshop-shared/src/api.ts:3211
  export type BlueprintMetadata = {
    ...
    screenshot?: true;
  };
  ```
  This is stored in the Gadget DO, copied to the User DO, and written to the `BLUEPRINTS` KV namespace.
- **Serving the image**:
  - The public URL is derived deterministically:
    ```ts
    // packages/workshop-shared/src/api.ts:3189-3192
    export function blueprintScreenshotUrl(id: string, metadata: { screenshot?: true, lastUpdated: Date }): string | undefined {
      return metadata.screenshot ?
          `${BLUEPRINT_SCREENSHOT_PATH_PREFIX}${id}?v=${metadata.lastUpdated.valueOf()}` : undefined;
    }
    ```
  - The router proxies `/blueprint-screenshot/*` to the Workshop Worker (`packages/router/src/index.ts`).
  - Workshop backend serves the image from R2 with immutable caching headers:
    ```ts
    // packages/workshop-backend/src/server.ts:603-618
    async function serveBlueprintScreenshot(env: Env, blueprintId: string): Promise<Response> {
      let object = await env.BLUEPRINT_CONTENT.get(`${BLUEPRINT_SCREENSHOT_R2_PREFIX}${blueprintId}`);
      if (!object) return new Response("Not Found", {status: 404});
      let contentType = object.httpMetadata?.contentType || "image/jpeg";
      return new Response(object.body, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    }
    ```

---

## 2. Why bundled format blueprints have no thumbnails

Deployments ship standard formats (like Workspace Docs, Sheets, Slides, Board, Notebook, Whiteboard) via static files. None of these currently display thumbnails for three reasons:

### 1. The sidecar validator forbids image fields
Bundled formats are paired files: `<name>.gadget` (binary archive) and `<name>.json` (sidecar metadata).
During build, [`packages/workshop-backend/scripts/build-format-blueprints.mjs:47-49`](packages/workshop-backend/scripts/build-format-blueprints.mjs) validates sidecar JSON:
```js
let { blueprintId, title, description, output, author, revision, $comment, ...rest } = parsed;
if (Object.keys(rest).length > 0) bad(`unknown keys: ${Object.keys(rest).join(", ")}`);
```
Any unexpected property causes `pnpm check` and the build to fail immediately. There is no `screenshot` or `thumbnail` property defined in the schema.

### 2. `.gadget` binary archives do not package screenshots
The `.gadget` binary format consists of a 24-byte prefix, UTF-8 JSON `BlueprintMetadata`, and gzip-compressed Yjs document bytes ([`packages/workshop-backend/src/blueprint-archive.ts:1-25`](packages/workshop-backend/src/blueprint-archive.ts)).

As noted in `docs/blueprints.md:97`:
> "Only `BlueprintMetadata` is included in the file, not the full KV record. In particular, the archive does not include `ownerId`, `gadgetId`, or screenshot bytes. Imported archives clear any screenshot marker because screenshots are stored separately from the archive content."

When an archive is imported, [`packages/workshop-backend/src/server.ts:396`](packages/workshop-backend/src/server.ts) explicitly removes the marker:
```ts
delete metadata.screenshot;
```

### 3. The installer does not write screenshots to R2
When the Worker starts and serves its first `/api` call, [`packages/workshop-backend/src/format-blueprints.ts:39-75`](packages/workshop-backend/src/format-blueprints.ts) installs bundled formats into the `BLUEPRINTS` KV namespace and `BLUEPRINT_CONTENT` R2 bucket.
`installOne()` sets:
```ts
let installed: BlueprintMetadata = {
  ...metadata,
  title: entry.title,
  description: entry.description,
  author: entry.author,
  output: entry.output,
};
await env.BLUEPRINT_CONTENT.put(`${entry.blueprintId}/${installed.version}`, contentBytes);
let kvRecord: BlueprintKvRecord = {metadata: installed};
await env.BLUEPRINTS.put(entry.blueprintId, JSON.stringify(kvRecord));
```
It neither sets `installed.screenshot = true` nor writes anything to `${BLUEPRINT_SCREENSHOT_R2_PREFIX}${entry.blueprintId}`. Consequently, `blueprintScreenshotUrl()` returns `undefined` for all bundled formats.

---

## 3. Frontend placeholder rendering

When `screenshotUrl` is `undefined`, preview components render a fallback:

- In [`packages/workshop-frontend/src/components/BlueprintPreviewImage.tsx:4-29`](packages/workshop-frontend/src/components/BlueprintPreviewImage.tsx):
  ```tsx
  export function BlueprintPreviewImage({ blueprintId, title, screenshotUrl, className }: Props) {
    return (
      <div className={`overflow-hidden rounded-xl border border-kumo-line bg-kumo-tint ${className ?? ''}`}>
        {screenshotUrl ? (
          <img src={screenshotUrl} alt={`Screenshot of ${title}`} className="aspect-[16/9] w-full object-cover" loading="lazy" />
        ) : (
          <BlueprintPreviewPlaceholder id={blueprintId} />
        )}
      </div>
    );
  }
  ```
- In [`BlueprintPreviewPlaceholder`](packages/workshop-frontend/src/components/BlueprintPreviewImage.tsx:31-59):
  - Calculates a subtle background gradient via `getGradient(id)` using a hash of the blueprint ID string.
  - Draws a static SVG wireframe representing a card with horizontal lines (resembling a table or document layout).
  - Positions an icon badge in the top-left corner containing a Phosphor `<Hexagon>` icon.
  - Does **not** inspect `blueprint.metadata.output.icon`. Every blueprint without a screenshot displays this identical document-table wireframe.

---

## 4. Workarounds and Extension Options

### A. No-code workaround (re-publish as user blueprint)
1. Launch an instance of the desired format (e.g. Board or Slides) from the **+ New** menu.
2. Open the **Blueprint** modal in the top editor header.
3. Click **Create Blueprint**, provide a title, description, and upload a custom 16:9 PNG/JPEG image in the **Screenshot** section.
4. Go to `/admin` -> **Formats** or **Featured** to promote/feature the new blueprint.

### B. Code extension: Bundled format screenshots
To let repository-defined formats in `formats/` ship with dedicated thumbnails:
1. **Sidecar / Asset pairing**: Allow an optional sibling image file in `formats/` (e.g. `formats/<name>.png` or `formats/<name>.jpg`).
2. **Build script bundle**: In [`scripts/build-format-blueprints.mjs`](packages/workshop-backend/scripts/build-format-blueprints.mjs), read the image file if present, base64-encode it, and add it to `BundledFormatBlueprint` in `src/generated/format-blueprints.ts`. Include the image hash in `formatBlueprintsManifestVersion()`.
3. **Installer write to R2**: In [`src/format-blueprints.ts:installOne()`](packages/workshop-backend/src/format-blueprints.ts), if image bytes are present on `entry`:
   - Store the decoded image into `env.BLUEPRINT_CONTENT.put(`${BLUEPRINT_SCREENSHOT_R2_PREFIX}${entry.blueprintId}`, imageBytes, { httpMetadata: { contentType: ... } })`.
   - Set `installed.screenshot = true`.

### C. Code extension: Icon-aware frontend placeholders
If static image bundling is not needed, [`BlueprintPreviewPlaceholder`](packages/workshop-frontend/src/components/BlueprintPreviewImage.tsx:31-59) can be updated to accept `icon?: BlueprintOutputIcon` or `output?: BlueprintOutput`:
- Render distinct wireframes or illustrations depending on the icon (e.g. Kanban columns for `kanban`, presentation slides for `presentation`, code cells for `notebook`, whiteboard shapes for `flowArrow`).
