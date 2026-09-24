// @ts-check
// The interface between the canvas (src/client/ui/canvas/**: rendering, camera, tools, gestures,
// selection, text editing, presence overlay) and the app shell (src/client/ui/*.js: layout,
// toolbar, style bar, people and follow, minimap, dialogs, export view). Types only.
//
// The shell owns the DOM around the canvas and every button; the canvas owns the <svg> and every
// pointer/keyboard gesture on it. Both talk to the Store (src/client/store-contract.js); neither
// calls `gadget`.

/** @typedef {import("../store-contract.js").Store} Store */
/** @typedef {import("../../shared/protocol.js").ObjectType} ObjectType */
/** @typedef {import("../../shared/protocol.js").WhiteboardObject} WhiteboardObject */

/**
 * select: pick, move, resize, rotate, marquee. hand: pan only.
 * The creation tools create on click (default size, centred on the pointer) or drag (sized box);
 * sticky and text start editing right away; connector drags from one object to another; pen draws.
 * After creating, the tool returns to "select" unless it was locked (double-click in the toolbar);
 * the pen stays active after each stroke.
 * @typedef {"select"|"hand"|"sticky"|"rect"|"ellipse"|"text"|"frame"|"connector"|"pen"} Tool
 */

/**
 * Screen = (world - {x, y}) * zoom, in CSS pixels relative to the canvas element.
 * @typedef {{x: number, y: number, zoom: number}} Camera
 */

/**
 * @typedef {object} CanvasEvents
 * @property {"tool"|"camera"|"selection"|"editing"|"follow"|"command"} kind
 *   tool: the active tool changed. camera: pan or zoom (fired at most once per animation frame).
 *   selection: the selected ids changed. editing: inline text editing started or stopped.
 *   follow: following stopped or started (the user panning stops it).
 *   command: a shortcut that belongs to the shell (keymap.js ShellCommand) was pressed on the
 *   canvas; carries {command}.
 *   The "tool" event also carries {tool, locked}.
 *
 * The canvas element also dispatches a bubbling CustomEvent "wb-contextmenu" with detail
 * {clientX, clientY, ids, pointerType: "mouse"|"touch"|"keyboard", rect?} on right-click, the
 * context menu key / Shift+F10 (for the current selection; `rect` is its client rect) and touch
 * long-press.
 * Marquee selection picks objects it touches, but a frame only when fully enclosed.
 */

/**
 * @typedef {object} CanvasController
 * @property {HTMLElement} element                  the canvas container the shell places in its layout
 * @property {() => Tool} getTool
 * @property {(tool: Tool, locked?: boolean) => void} setTool
 * @property {() => Camera} getCamera
 * @property {(camera: Camera, animate?: boolean) => void} setCamera   clamps zoom to ZOOM_MIN..ZOOM_MAX
 * @property {(factor: number) => void} zoomBy       about the view centre
 * @property {() => void} zoomToFit                  fits all objects (or resets to 100% on an empty board)
 * @property {() => {x: number, y: number, w: number, h: number}} getViewport  world rect currently visible
 * @property {() => string[]} getSelection
 * @property {(ids: string[]) => void} setSelection  unknown ids are dropped
 * @property {(type: ObjectType) => string|null}  addAtCenter
 *   Keyboard and button path for creating: adds a default-sized object of `type` at the view centre
 *   (not "pen" or "connector"), selects it, starts text editing for sticky/text, returns its id.
 * @property {(id: string) => void} editText         starts inline text editing of an object
 * @property {(clientId: string|null) => void} follow  follow a peer's viewport, or stop
 * @property {() => string|null} getFollowing
 * @property {(ids: string[]) => void} duplicate     copies of the objects offset by 20 units, selected
 * @property {(ids: string[]) => void} focusObjects  pans (and zooms out if needed) so the objects are visible
 * @property {(mode: "left"|"center"|"right"|"top"|"middle"|"bottom") => number} align
 *   aligns the selection (2+ movable units; a selected frame brings its members) in ONE update, so
 *   one undo reverses it; returns how many objects moved
 * @property {(axis: "horizontal"|"vertical") => number} distribute
 *   spaces the selection (3+ units) evenly, first and last fixed; one update; returns objects moved
 * @property {(connectorId: string, end: "from"|"to", targetId: string) => boolean} reconnect
 *   moves one end of a connector to another non-connector object (never the other end); the rest
 *   of the connector is kept. False when nothing changed or the target is not valid
 * @property {() => import("../model/spatial-index.js").SpatialQuery} getSpatialIndex
 *   read-only spatial queries over every object's effective world bounds (culling, minimap)
 * @property {(ids: string[], opts?: {padding?: number, animate?: boolean}) => boolean} fitObjects
 *   fits the view to the objects (zooming in or out; animated unless reduced motion is asked for);
 *   false when none of them exists
 * @property {() => {x: number, y: number}|null} getPointer  world position of the pointer while it
 *   is over the canvas, else null
 * @property {(listener: (event: CanvasEvents) => void) => () => void} on
 * @property {() => void} destroy
 */

/**
 * createCanvas(store, options) -> CanvasController, exported from src/client/ui/canvas/index.js.
 * @typedef {object} CanvasOptions
 * @property {(message: string) => void} [announce]  polite live-region announcement (the shell provides it)
 * @property {boolean} [exportMode]  static render for HTML/PDF export: no gestures, no presence, fit to content
 * @property {(type: ObjectType) => Partial<import("../../shared/protocol.js").Style>} [toolStyle]
 *   style for newly created objects of `type` (e.g. the current pen colour); type defaults otherwise
 */

export {};
