# @ace-code/tsyntax

Scoped alias for [**tsyntax**](https://www.npmjs.com/package/tsyntax) — a
lightweight ~17 KB parser for scalar TypeScript-syntax DSL strings, validated
at the type level and at runtime.

This package re-exports `tsyntax` unchanged, and ships the same way: compiled
ESM (`dist/index.js`) plus declarations (`dist/index.d.ts`), no TypeScript
source. It exists only to provide the scoped name. Prefer the plain
[`tsyntax`](https://github.com/AceCodePt/tsyntax) package unless you need the
scope.

```ts
import { dslString, SUPPORTED_KEYWORDS } from "@ace-code/tsyntax";
```

- npm: https://www.npmjs.com/package/@ace-code/tsyntax
- source: https://github.com/AceCodePt/tsyntax
