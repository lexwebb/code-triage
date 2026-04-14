/// <reference types="vite/client" />

// Ambient declarations for refractor modules whose package exports map lacks a
// "types" condition, so TypeScript can't auto-resolve them.
// The exports map is: "./*" -> "./lang/*.js", so "refractor/tsx" -> "lang/tsx.js"
declare module "refractor/core" {
  export { refractor } from "refractor/lib/core.js";
}

declare module "refractor/*" {
  import type { Syntax } from "refractor/lib/core.js";
  const lang: Syntax;
  export default lang;
}
