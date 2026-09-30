/** Input language. Mermaid is converted to D2 before rendering. */
export type DiagramLanguage = "d2" | "mermaid";
/** General layout engines; sequence and grid diagrams use D2's specialized layouts. */
export type DiagramLayout = "tala" | "dagre" | "elk";
/** Available vector, raster, document, text and source outputs. */
export type DiagramFormat = "svg" | "png" | "jpeg" | "webp" | "pdf" | "ascii" | "source" | "d2" | "json";
/** A self-contained diagram and its output options. */
export interface DiagramRequest {
  /** Up to 100,000 UTF-8 bytes. File imports and external images are unavailable. */
  source: string;
  /** Defaults to d2. Mermaid supports flowchart, sequence, state, class, ER, mindmap and C4. */
  language?: DiagramLanguage;
  /** Defaults to tala. */
  layout?: DiagramLayout;
  /** Defaults to svg. */
  format?: DiagramFormat;
  /** D2 theme ID: 0, 1, 103, 104 or 200; defaults to 104. */
  theme?: number;
  /** Hand-drawn rendering; defaults to false. */
  sketch?: boolean;
  /** Raster/PDF resolution: 1, 2 or 3; defaults to 2. */
  scale?: number;
}
/** A file ready for Blob/download, storage, or embedding in another app. */
export interface DiagramResult {
  /** Raw file bytes, including UTF-8 bytes for text outputs. */
  data: Uint8Array;
  /** MIME type for the requested format. */
  contentType: string;
  /** Suggested file name, including extension. */
  filename: string;
  /** Normalized input language. */
  language: DiagramLanguage;
  /** Selected general layout engine. */
  layout: DiagramLayout;
  /** Requested output format. */
  format: DiagramFormat;
  /** The normalized/converted D2 source; omitted for original source exports. */
  d2Source?: string;
  /** Number of compiled graph shapes; zero for uncompiled source exports. */
  nodes: number;
  /** Number of compiled graph connections; zero for uncompiled source exports. */
  edges: number;
}
/** Diagram rendering for reusable apps and agents. */
export interface DiagramSession {
  /** Render a diagram. Invalid syntax/options, resource limits, and unavailable browser capacity throw. */
  render(request: DiagramRequest): Promise<DiagramResult>;
  /** Return supported languages, layouts, formats and operational limits. */
  describeCapabilities(): Promise<DiagramCapabilities>;
  /** Read a bundled skill by ID: mermaid2-connector, mermaid2-blueprint or d2-authoring. */
  readSkill(id: string): Promise<string>;
}
/** Discover the formats and bounds before rendering. */
export interface DiagramCapabilities {
  /** Accepted input languages. */
  languages: DiagramLanguage[];
  /** General layout engines. */
  layouts: DiagramLayout[];
  /** Output formats. PDF is a raster image on a single page. */
  formats: DiagramFormat[];
  /** Maximum input size in UTF-8 bytes. */
  maxSourceBytes: number;
  /** Maximum generated file size. */
  maxOutputBytes: number;
  /** Maximum raster/PDF image area. */
  maxRasterPixels: number;
  /** Diagram sources are processed ephemerally and external network resources are blocked. */
  externalResources: false;
}
