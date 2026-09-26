// @ts-check
// The built-in reports: a Vega-Lite (or, for the dependency graph, Vega) spec bound to a named
// dataset. Specs read their rows from `{ "name": "<dataset>" }`; the Reports screen (and any
// renderer) supplies the rows. Colours come from two named schemes the renderer registers for
// the current theme: `workboard-kinds` (one colour per state kind, fixed order) and
// `workboard-series` (categorical series). Agents may use both in their own specs.

export const KIND_DOMAIN = Object.freeze(["Triage", "Backlog", "Unstarted", "Started", "Completed", "Canceled"]);
const LITE = "https://vega.github.io/schema/vega-lite/v6.json";
const VEGA = "https://vega.github.io/schema/vega/v6.json";

const kindColor = { field: "kind_label", type: "nominal", title: "State", scale: { domain: KIND_DOMAIN, scheme: "workboard-kinds" } };
// Days are UTC dates: read and shown in UTC whatever the viewer's time zone.
const dayAxis = { field: "day", type: "temporal", title: null, scale: { type: "utc" }, axis: { format: "%d %b", labelOverlap: true, tickCount: 6 } };

/**
 * @typedef {{ id: string, title: string, description: string, dataset: string, params: Record<string, unknown>, query: string,
 *   spec: Record<string, any>, builtin: true, controls?: string[] }} BuiltinReport
 */

/** @type {BuiltinReport[]} */
export const BUILTIN_REPORTS = [
  {
    id: "cfd", title: "Cumulative flow", builtin: true, dataset: "daily_state_counts", params: { days: 30 }, query: "",
    description: "Items in each state kind at the end of every day, stacked. Widening bands show where work piles up.",
    spec: {
      $schema: LITE, data: { name: "daily_state_counts" },
      mark: { type: "area", interpolate: "monotone", stroke: { expr: "surface" }, strokeWidth: 1 },
      encoding: {
        x: dayAxis,
        y: { field: "count", type: "quantitative", stack: "zero", title: "Items" },
        color: kindColor,
        order: { field: "order", type: "quantitative", sort: "descending" },
        tooltip: [{ field: "day", type: "temporal", title: "Day", format: "%a %d %b", formatType: "utc" }, { field: "kind_label", title: "State" }, { field: "count", title: "Items" }, { field: "points", title: "Points" }],
      },
    },
  },
  {
    id: "cycle-time", title: "Cycle time", builtin: true, dataset: "cycle_time", params: { days: 90 }, query: "",
    description: "Days from starting to finishing each completed item, with the rolling average and the 50th and 85th percentiles.",
    spec: {
      $schema: LITE, data: { name: "cycle_time" },
      layer: [
        {
          mark: { type: "point", filled: true, size: 48, opacity: 0.75 },
          encoding: {
            x: { field: "completed", type: "temporal", title: null, scale: { type: "utc" }, axis: { format: "%d %b", labelOverlap: true, tickCount: 6 } },
            y: { field: "days", type: "quantitative", title: "Days", scale: { type: "sqrt", zero: true } },
            color: { datum: "Item", type: "nominal", scale: { domain: ["Item", "Rolling average"], scheme: "workboard-series" }, title: null },
            tooltip: [{ field: "key", title: "Item" }, { field: "title", title: "Title" }, { field: "days", title: "Days" }, { field: "assignee", title: "Assignee" }, { field: "completed", type: "temporal", title: "Completed", format: "%d %b", formatType: "utc" }],
          },
        },
        { mark: { type: "line", strokeWidth: 2, interpolate: "monotone" }, encoding: { x: { field: "completed", type: "temporal", scale: { type: "utc" } }, y: { field: "rolling_avg", type: "quantitative" }, color: { datum: "Rolling average", type: "nominal" } } },
        { mark: { type: "rule", strokeDash: [4, 4], color: { expr: "muted" } }, encoding: { y: { aggregate: "max", field: "p50", type: "quantitative" } } },
        { mark: { type: "rule", strokeDash: [2, 3], color: { expr: "muted" } }, encoding: { y: { aggregate: "max", field: "p85", type: "quantitative" } } },
        {
          mark: { type: "text", align: "right", dx: -2, dy: -6, color: { expr: "muted" }, fontSize: 11 },
          transform: [{ aggregate: [{ op: "max", field: "p50", as: "v" }, { op: "max", field: "completed", as: "x" }] }, { calculate: "'50%: ' + datum.v + ' d'", as: "label" }],
          encoding: { x: { field: "x", type: "temporal", scale: { type: "utc" } }, y: { field: "v", type: "quantitative" }, text: { field: "label" } },
        },
        {
          mark: { type: "text", align: "right", dx: -2, dy: -6, color: { expr: "muted" }, fontSize: 11 },
          transform: [{ aggregate: [{ op: "max", field: "p85", as: "v" }, { op: "max", field: "completed", as: "x" }] }, { calculate: "'85%: ' + datum.v + ' d'", as: "label" }],
          encoding: { x: { field: "x", type: "temporal", scale: { type: "utc" } }, y: { field: "v", type: "quantitative" }, text: { field: "label" } },
        },
      ],
    },
  },
  {
    id: "burndown", title: "Cycle burndown", builtin: true, dataset: "cycle_burndown", params: { cycle: "current" }, query: "", controls: ["cycle"],
    description: "Work remaining in the cycle each day against the ideal straight line to zero.",
    spec: {
      $schema: LITE, data: { name: "cycle_burndown" },
      transform: [{ fold: ["remaining", "ideal"], as: ["series", "value"] }, { calculate: "datum.series === 'remaining' ? 'Remaining' : 'Ideal'", as: "Series" }],
      mark: { type: "line", strokeWidth: 2, point: { filled: true, size: 30 } },
      encoding: {
        x: dayAxis,
        y: { field: "value", type: "quantitative", title: "Remaining" },
        color: { field: "Series", type: "nominal", title: null, scale: { domain: ["Remaining", "Ideal"], scheme: "workboard-series" } },
        strokeDash: { field: "Series", type: "nominal", scale: { domain: ["Remaining", "Ideal"], range: [[1, 0], [5, 4]] }, legend: null },
        tooltip: [{ field: "day", type: "temporal", title: "Day", format: "%a %d %b", formatType: "utc" }, { field: "remaining", title: "Remaining" }, { field: "scope", title: "Scope" }, { field: "completed", title: "Done" }, { field: "ideal", title: "Ideal" }],
      },
    },
  },
  {
    id: "burnup", title: "Cycle burnup", builtin: true, dataset: "burnup", params: { scope: "cycle", cycle: "current" }, query: "", controls: ["cycle"],
    description: "Scope and completed work in the cycle each day: the gap is what is left, a rising scope line is scope creep.",
    spec: {
      $schema: LITE, data: { name: "burnup" },
      transform: [{ fold: ["scope", "completed"], as: ["series", "value"] }, { calculate: "datum.series === 'scope' ? 'Scope' : 'Completed'", as: "Series" }],
      mark: { type: "line", strokeWidth: 2, interpolate: "step-after" },
      encoding: {
        x: dayAxis,
        y: { field: "value", type: "quantitative", title: "Work" },
        color: { field: "Series", type: "nominal", title: null, scale: { domain: ["Scope", "Completed"], scheme: "workboard-series" } },
        tooltip: [{ field: "day", type: "temporal", title: "Day", format: "%a %d %b", formatType: "utc" }, { field: "scope", title: "Scope" }, { field: "completed", title: "Completed" }],
      },
    },
  },
  {
    id: "throughput", title: "Throughput", builtin: true, dataset: "throughput", params: { weeks: 12 }, query: "",
    description: "Items completed each week. The current week is still running and drawn lighter.",
    spec: {
      $schema: LITE, data: { name: "throughput" },
      mark: { type: "bar", cornerRadiusEnd: 4, width: { band: 0.7 } },
      encoding: {
        x: { field: "week", type: "ordinal", timeUnit: "utcyearmonthdate", title: "Week starting", axis: { format: "%d %b", labelAngle: 0, labelOverlap: true } },
        y: { field: "completed", type: "quantitative", title: "Items completed" },
        color: { datum: "Completed", type: "nominal", scale: { domain: ["Completed"], scheme: "workboard-series" }, legend: null },
        opacity: { condition: { test: "datum.partial", value: 0.45 }, value: 1 },
        tooltip: [{ field: "week", type: "temporal", title: "Week of", format: "%d %b", formatType: "utc" }, { field: "completed", title: "Items" }, { field: "points", title: "Points" }, { field: "partial", title: "Week in progress" }],
      },
    },
  },
  {
    id: "created-resolved", title: "Created vs resolved", builtin: true, dataset: "created_vs_resolved", params: { days: 30 }, query: "",
    description: "Running totals of items created and resolved. When the created line pulls ahead, open work is growing.",
    spec: {
      $schema: LITE, data: { name: "created_vs_resolved" },
      transform: [{ fold: ["created_total", "resolved_total"], as: ["series", "value"] }, { calculate: "datum.series === 'created_total' ? 'Created' : 'Resolved'", as: "Series" }],
      mark: { type: "line", strokeWidth: 2, interpolate: "monotone" },
      encoding: {
        x: dayAxis,
        y: { field: "value", type: "quantitative", title: "Items (running total)" },
        color: { field: "Series", type: "nominal", title: null, scale: { domain: ["Created", "Resolved"], scheme: "workboard-series" } },
        tooltip: [{ field: "day", type: "temporal", title: "Day", format: "%a %d %b", formatType: "utc" }, { field: "created", title: "Created that day" }, { field: "resolved", title: "Resolved that day" }, { field: "created_total", title: "Created (total)" }, { field: "resolved_total", title: "Resolved (total)" }],
      },
    },
  },
  {
    id: "workload", title: "Workload by assignee", builtin: true, dataset: "workload", params: {}, query: "",
    description: "Committed, unfinished items per person, split into not started and in progress.",
    spec: {
      $schema: LITE, data: { name: "workload" },
      mark: { type: "bar", cornerRadiusEnd: 3, stroke: { expr: "surface" }, strokeWidth: 1 },
      encoding: {
        y: { field: "assignee", type: "nominal", title: null, sort: { field: "total_count", order: "descending" } },
        x: { field: "count", type: "quantitative", stack: "zero", title: "Items" },
        color: kindColor,
        order: { field: "order", type: "quantitative", sort: "descending" },
        tooltip: [{ field: "assignee", title: "Person" }, { field: "kind_label", title: "State" }, { field: "count", title: "Items" }, { field: "points", title: "Points" }, { field: "total_count", title: "All their items" }],
      },
    },
  },
  {
    id: "dependencies", title: "Dependencies", builtin: true, dataset: "dependencies", params: {}, query: "",
    description: "Unfinished items that block each other. Arrows point from the blocker to the blocked item; orange links form chains.",
    spec: {
      $schema: VEGA, width: 640, height: 320, padding: 8, autosize: "none",
      signals: [{ name: "cx", update: "width / 2" }, { name: "cy", update: "height / 2" }],
      data: [
        { name: "dependencies" },
        { name: "node-data", source: "dependencies", transform: [{ type: "filter", expr: "datum.type === 'node'" }, { type: "formula", expr: "cx", as: "tx" }, { type: "formula", expr: "cy", as: "ty" }] },
        { name: "link-data", source: "dependencies", transform: [{ type: "filter", expr: "datum.type === 'edge'" }] },
      ],
      scales: [{ name: "kind", type: "ordinal", domain: ["triage", "backlog", "unstarted", "started", "completed", "canceled"], range: { scheme: "workboard-kinds" } }],
      marks: [
        {
          name: "links", type: "path", from: { data: "link-data" }, interactive: false,
          encode: { update: { stroke: [{ test: "datum.critical", signal: "linkHot" }, { signal: "linkCold" }], strokeWidth: [{ test: "datum.critical", value: 2 }, { value: 1.25 }] } },
          transform: [{ type: "linkpath", require: { signal: "force" }, shape: "line", sourceX: "datum.source.x", sourceY: "datum.source.y", targetX: "datum.target.x", targetY: "datum.target.y" }],
        },
        {
          name: "arrows", type: "symbol", from: { data: "link-data" }, interactive: false,
          encode: {
            update: {
              shape: { value: "triangle-up" }, size: { value: 60 },
              fill: [{ test: "datum.critical", signal: "linkHot" }, { signal: "linkCold" }],
              x: { signal: "datum.target.x - 13 * cos(atan2(datum.target.y - datum.source.y, datum.target.x - datum.source.x))" },
              y: { signal: "datum.target.y - 13 * sin(atan2(datum.target.y - datum.source.y, datum.target.x - datum.source.x))" },
              angle: { signal: "90 + atan2(datum.target.y - datum.source.y, datum.target.x - datum.source.x) * 180 / PI" },
            },
          },
        },
        {
          name: "nodes", type: "symbol", zindex: 1, from: { data: "node-data" },
          encode: {
            enter: { fill: { scale: "kind", field: "kind" }, stroke: { signal: "surface" }, strokeWidth: { value: 2 } },
            update: {
              shape: [{ test: "datum.blocked", value: "diamond" }, { value: "circle" }],
              size: [{ test: "datum.blocking > 1", value: 320 }, { value: 200 }],
              opacity: [{ test: "datum.context", value: 0.55 }, { value: 1 }],
              tooltip: { signal: "{ title: datum.key + ' ' + datum.title, State: datum.state, Assignee: datum.assignee || 'Unassigned', Blocked: datum.blocked ? 'yes' : 'no', Blocks: datum.blocking }" },
              cursor: { value: "pointer" },
            },
          },
          transform: [{
            type: "force", iterations: 300, static: true, signal: "force",
            forces: [
              { force: "center", x: { signal: "cx" }, y: { signal: "cy" } },
              { force: "collide", radius: 16 },
              { force: "nbody", strength: -36 },
              { force: "link", links: "link-data", distance: 46, id: "datum.key" },
              { force: "x", x: "datum.tx", strength: 0.04 },
              { force: "y", y: "datum.ty", strength: 0.08 },
            ],
          }],
        },
        {
          name: "labels", type: "text", from: { data: "nodes" }, interactive: false,
          encode: { update: { x: { field: "x" }, y: { field: "y", offset: 18 }, text: { field: "datum.key" }, align: { value: "center" }, fontSize: { value: 10 }, fill: { signal: "ink" } } },
        },
      ],
    },
  },
];

/** @param {string} id */
export function builtinReport(id) { return BUILTIN_REPORTS.find((r) => r.id === id) ?? null; }
