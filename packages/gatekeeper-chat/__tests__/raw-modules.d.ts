// `import x from "./file?raw"` is a Vite feature, not a TypeScript one. `__tests__/vendor.test.ts`
// uses it to read `src/vendor/types.d.ts` as text and compare it with the string `types-code.ts`
// serves to the agent, which is what keeps the two from drifting.
declare module "*?raw" {
  const content: string;
  export default content;
}
