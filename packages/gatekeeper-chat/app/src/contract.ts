// The single door between the app and the shared contract.
//
// `src/shared/*` is owned by the Worker half and is types plus pure helpers only, so the SPA can
// import it directly. Re-exporting it once keeps every component's import short and, more usefully,
// makes it obvious in review that no component invents a URL: `apiPath`, `buildPath`, `filePath` and
// `permalink` are the only way paths are produced.
export * from "../../src/shared/protocol.js";
export * from "../../src/shared/routes.js";
export { utf8Bytes } from "../../src/shared/validate.js";
