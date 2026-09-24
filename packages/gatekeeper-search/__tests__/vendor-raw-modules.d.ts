// `import x from "./file?raw"` is a Vite feature, not a TypeScript one; vendor.test.ts uses it to
// compare the served agent types against types.d.ts.
declare module "*?raw" {
  const content: string;
  export default content;
}
