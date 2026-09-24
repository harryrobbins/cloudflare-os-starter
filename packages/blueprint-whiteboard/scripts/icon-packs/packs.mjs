// @ts-check
// Declared icon packs: which pinned source files are compiled, and the metadata each icon gets.
// scripts/build-icon-packs.mjs reads only the files named here.
//
// Pack ids are "<name>.<version>". A published (packId, iconId) keeps resolving forever: the
// ledger (published.json) records a hash of every published icon's compiled geometry, and the
// build fails when one changes or disappears. To change a glyph materially (for example after an
// upstream bump), add a new pack version and keep the old one.

/**
 * @typedef {object} IconDecl
 * @property {string} id
 * @property {string} [label]      defaults to the id in sentence case
 * @property {string[]} [tags]
 * @property {[number, number, number, number]} [textBox]  where text goes, as fractions of the box
 */

/**
 * @typedef {object} PackDecl
 * @property {string} id
 * @property {string} name
 * @property {"stencil"|"glyph"} kind
 *   stencil: shapes that stretch to their box, take the object's fill and hold text; line width is
 *   in world units like a rectangle's. glyph: symbols drawn at their aspect ratio inside the box,
 *   line width in the icon's own units (it scales with the icon).
 * @property {{type: "first-party"} | {type: "npm", package: string, version: string, dir: string, url: string}} source
 * @property {{spdx: string, copyright: string, file?: string}} licence  `file`: the licence text,
 *   relative to the source package, shipped in the generated module and THIRD_PARTY_NOTICES.md
 * @property {string|null} fillToken   source colour meaning "the object's fill"
 * @property {number} strokeWidth      the stroke-width every source declares
 * @property {{id: string, label: string, icons: (string|IconDecl)[]}[]} categories
 */

/** @type {PackDecl} */
const core = {
  id: "core.1",
  name: "Diagram shapes",
  kind: "stencil",
  source: { type: "first-party" },
  licence: { spdx: "first-party", copyright: "Part of the Whiteboard blueprint" },
  fillToken: "#ffffff",
  strokeWidth: 2,
  categories: [
    {
      id: "flowchart", label: "Flowchart", icons: [
        { id: "process", tags: ["step", "action", "task", "box"], textBox: [0, 0, 1, 1] },
        { id: "decision", tags: ["diamond", "choice", "branch", "if", "condition", "question"], textBox: [0.22, 0.22, 0.56, 0.56] },
        { id: "terminator", label: "Start / end", tags: ["terminator", "start", "end", "stop", "begin", "pill", "stadium"], textBox: [0.12, 0, 0.76, 1] },
        { id: "data", label: "Data (input / output)", tags: ["input", "output", "io", "parallelogram"], textBox: [0.19, 0, 0.62, 1] },
        { id: "document", tags: ["page", "report", "paper", "file"], textBox: [0, 0, 1, 0.82] },
        { id: "multi-document", label: "Multiple documents", tags: ["documents", "pages", "reports", "files"], textBox: [0, 0.15, 0.9, 0.66] },
        { id: "predefined-process", label: "Predefined process", tags: ["subroutine", "subprocess", "function"], textBox: [0.1, 0, 0.8, 1] },
        { id: "manual-input", label: "Manual input", tags: ["keyboard", "entry", "form"], textBox: [0, 0.3, 1, 0.7] },
        { id: "manual-operation", label: "Manual operation", tags: ["trapezoid", "human", "offline"], textBox: [0.19, 0, 0.62, 1] },
        { id: "preparation", tags: ["hexagon", "setup", "initialise", "loop"], textBox: [0.19, 0, 0.62, 1] },
        { id: "delay", tags: ["wait", "pause", "d shape"], textBox: [0, 0, 0.8, 1] },
        { id: "merge", tags: ["triangle", "combine", "join"], textBox: [0.2, 0, 0.6, 0.5] },
        { id: "off-page", label: "Off-page reference", tags: ["connector", "continue", "pentagon", "link"], textBox: [0, 0, 1, 0.6] },
        { id: "on-page-reference", label: "On-page reference", tags: ["connector", "circle", "jump", "junction"], textBox: [0.15, 0.15, 0.7, 0.7] },
        { id: "annotation", tags: ["comment", "bracket", "note", "remark"], textBox: [0.08, 0, 0.92, 1] },
        { id: "note", tags: ["memo", "folded", "comment", "card"], textBox: [0, 0.22, 1, 0.78] },
      ],
    },
    {
      id: "architecture", label: "Architecture", icons: [
        { id: "database", tags: ["cylinder", "db", "storage", "sql", "data", "table"], textBox: [0, 0.3, 1, 0.6] },
        { id: "cloud", tags: ["internet", "saas", "hosting", "provider", "network"], textBox: [0.14, 0.34, 0.72, 0.56] },
        { id: "server", tags: ["host", "machine", "rack", "backend", "vm"] },
        { id: "queue", tags: ["message", "stream", "broker", "kafka", "bus", "topic", "cylinder"], textBox: [0.12, 0, 0.66, 1] },
        { id: "actor", label: "User (actor)", tags: ["user", "person", "people", "human", "stick figure", "role"] },
        { id: "component", tags: ["service", "module", "microservice", "uml"], textBox: [0.24, 0, 0.74, 1] },
        { id: "browser", label: "Web browser", tags: ["web", "website", "frontend", "window", "app", "client"], textBox: [0, 0.2, 1, 0.8] },
        { id: "mobile", label: "Mobile device", tags: ["phone", "app", "client", "smartphone"], textBox: [0.08, 0.15, 0.84, 0.68] },
        { id: "firewall", tags: ["security", "wall", "bricks", "waf", "network"] },
        { id: "load-balancer", label: "Load balancer", tags: ["router", "proxy", "gateway", "traffic", "distribute"] },
        { id: "storage", label: "Object storage", tags: ["bucket", "blob", "files", "s3", "r2"], textBox: [0.15, 0.3, 0.7, 0.62] },
      ],
    },
  ],
};

/** @type {PackDecl} */
const tabler = {
  id: "tabler.1",
  name: "Tabler Icons",
  kind: "glyph",
  source: {
    type: "npm", package: "@tabler/icons", version: "3.48.0", dir: "icons/outline",
    url: "https://github.com/tabler/tabler-icons",
  },
  licence: { spdx: "MIT", copyright: "Copyright (c) 2020-2026 Paweł Kuna", file: "LICENSE" },
  fillToken: null,
  strokeWidth: 2,
  categories: [
    {
      id: "people", label: "People", icons: [
        "user", "user-circle", "users", "users-group", "user-plus", "user-minus", "user-check", "user-x", "user-shield",
        "user-cog", "user-search", "user-star", "man", "woman", "friends", "id-badge", "id-badge-2", "heart-handshake",
        "school", "briefcase", "robot", "mood-smile", "hand-stop", "accessible",
      ],
    },
    {
      id: "devices", label: "Devices", icons: [
        "device-desktop", "device-laptop", "device-mobile", "device-tablet", "device-watch", "device-tv", "printer",
        "keyboard", "mouse", "headphones", "microphone", "camera", "video", "cpu", "device-floppy", "device-sd-card", "usb",
        "battery", "plug", "router", "device-gamepad-2", "server-2", "scan",
      ],
    },
    {
      id: "files", label: "Files", icons: [
        "file", "file-text", "file-code", "file-spreadsheet", "file-description", "file-zip", "file-type-pdf",
        "file-invoice", "files", "folder", "folder-open", "folder-plus", "notebook", "clipboard", "clipboard-check",
        "clipboard-list", "book", "news", "archive", "paperclip", "photo", "presentation", "report", "file-analytics",
      ],
    },
    {
      id: "actions", label: "Actions", icons: [
        "plus", "minus", "x", "check", "edit", "pencil", "trash", "copy", "search", "filter", "settings", "adjustments",
        "refresh", "reload", "download", "upload", "share", "link", "external-link", "send", "login", "logout", "eye",
        "eye-off", "bookmark", "star", "heart", "flag", "pin", "bell", "calendar", "clock", "player-play", "player-pause",
        "player-stop", "repeat", "arrow-right", "arrow-left", "arrow-up", "arrow-down", "arrows-exchange", "arrow-back-up",
        "switch-horizontal",
      ],
    },
    {
      id: "data", label: "Data", icons: [
        "database", "database-export", "database-import", "database-cog", "table", "table-options", "chart-bar",
        "chart-line", "chart-pie", "chart-dots", "chart-area", "chart-arrows-vertical", "chart-donut", "sql", "json", "api",
        "code", "braces", "binary", "math-function", "variable", "schema", "sitemap", "hierarchy", "filter-2",
        "sort-ascending", "list-numbers", "list-check", "timeline", "stack-2", "stack-3", "hash", "analyze",
      ],
    },
    {
      id: "network", label: "Network", icons: [
        "network", "world", "world-www", "wifi", "wifi-off", "antenna", "access-point", "router-off", "cloud-network",
        "topology-star", "topology-star-3", "topology-ring", "topology-bus", "topology-complex", "broadcast", "rss",
        "affiliate", "share-2", "git-branch", "git-merge", "git-pull-request", "git-commit", "webhook", "plug-connected",
        "arrows-split", "arrows-join", "arrows-shuffle",
      ],
    },
    {
      id: "infrastructure", label: "Cloud and infrastructure", icons: [
        "cloud", "cloud-upload", "cloud-download", "cloud-computing", "cloud-lock", "cloud-data-connection", "server",
        "server-bolt", "server-cog", "server-off", "container", "box", "box-multiple", "packages", "package", "stack-push",
        "stack-pop", "building", "building-factory", "building-warehouse", "building-bank", "cpu-2", "terminal",
        "terminal-2", "brand-docker", "cube", "bolt", "layers-intersect", "load-balancer", "gauge", "activity", "heartbeat",
        "recycle",
      ],
    },
    {
      id: "security", label: "Security", icons: [
        "lock", "lock-open", "key", "shield", "shield-check", "shield-lock", "shield-x", "fingerprint", "password",
        "alert-triangle", "alert-circle", "bug", "virus", "certificate", "eye-check", "lock-access",
      ],
    },
    {
      id: "communication", label: "Communication", icons: [
        "mail", "message", "message-circle", "messages", "phone", "phone-call", "inbox", "at", "bell-ringing", "speakerphone",
      ],
    },
  ],
};

/** Packs in picker and search order. */
export const PACKS = [core, tabler];
