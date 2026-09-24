// @ts-check
// Code block palettes. Every token colour, the line numbers and the header text reach WCAG AA
// (4.5:1) against the background they are drawn on, in both themes (checked by
// test/shared/code.test.js).

/**
 * @typedef {object} CodeTheme
 * @property {string} background  body
 * @property {string} header      header strip
 * @property {string} headerText
 * @property {string} border
 * @property {string} gutter      line numbers
 * @property {Record<import("./lexer.js").TokenClass, string>} tokens
 */

/** @type {Readonly<Record<"light"|"dark", CodeTheme>>} */
export const CODE_THEMES = Object.freeze({
  light: {
    background: "#f6f8fa", header: "#eaeef2", headerText: "#424a53", border: "#d0d7de", gutter: "#57606a",
    tokens: {
      "": "#1f2328", comment: "#57606a", keyword: "#cf222e", string: "#0a3069", number: "#0550ae",
      type: "#953800", function: "#6639ba", property: "#0550ae", tag: "#116329", meta: "#8250df",
      variable: "#953800", constant: "#0550ae", inserted: "#116329", deleted: "#a40e26", heading: "#0550ae",
    },
  },
  dark: {
    background: "#0d1117", header: "#161b22", headerText: "#c9d1d9", border: "#30363d", gutter: "#8b949e",
    tokens: {
      "": "#e6edf3", comment: "#8b949e", keyword: "#ff7b72", string: "#a5d6ff", number: "#79c0ff",
      type: "#ffa657", function: "#d2a8ff", property: "#79c0ff", tag: "#7ee787", meta: "#d2a8ff",
      variable: "#ffa657", constant: "#79c0ff", inserted: "#7ee787", deleted: "#ffa198", heading: "#79c0ff",
    },
  },
});

/** @param {unknown} theme @returns {CodeTheme} */
export function codeTheme(theme) {
  return theme === "dark" ? CODE_THEMES.dark : CODE_THEMES.light;
}
