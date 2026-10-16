# tsyntax

**tsyntax** - TypeScript-syntax **DSL strings**, parsed identically at the
**type level** and at **runtime**. One string, two walls: it gives you both
runtime and compile time checks for the price of knowing TypeScript.

Write a type as a string and get three things from a single source of truth:

1. **Compile-time validation** of the string itself (`tsc` rejects `"xyz"` or
   `"string |"` with a pointed message, and offers autocomplete as you type a
   union).
2. **Type inference** - the string's literal type (`"'ltr' | 'rtl' |
   undefined"` infers to `"ltr" | "rtl" | undefined`).
3. **Runtime validation** of values against that string.

The same string is parsed twice - once by TypeScript's type system, once by
plain JavaScript - and both parsers agree.

```ts
import { dslString, parseValueAgainstDSL, SUPPORTED_KEYWORDS } from "tsyntax";
import type { DSLInfer, DSLValidate } from "tsyntax";

type Dir = DSLInfer<typeof SUPPORTED_KEYWORDS, "'ltr' | 'rtl' | undefined">;
//   ^? "ltr" | "rtl" | undefined

const validated = dslString(SUPPORTED_KEYWORDS, "'ltr' | 'rtl' | undefined");
// throws at runtime on a malformed string: "string |", "| string", "xyz", ...

parseValueAgainstDSL(SUPPORTED_KEYWORDS, "'ltr' | 'rtl'", "rtl"); // ok
parseValueAgainstDSL(SUPPORTED_KEYWORDS, "'ltr' | 'rtl'", "center"); // throws
```

## Distribution

The published package is **compiled ESM plus declarations** — `dist/index.js`
and `dist/index.d.ts` — selected by an `exports` map:

```json
"exports": {
  ".": {
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js",
    "default": "./dist/index.js"
  }
}
```

So it runs in plain `node` (no loader, no `tsx`), in Bun, and in bundlers, and
`tsc` reads the declarations directly. The `main` field deliberately does **not**
point at `src/index.ts`: Node refuses to strip types for files inside
`node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), which is exactly
how `1.1.3` shipped unusable there. The source lives in this repo, not in the
tarball.

`pnpm test:package` guards it: it packs the tarballs, installs them into a
throwaway `node_modules`, imports them with plain `node`, and type-checks a
consumer against the shipped `.d.ts`.

ESM only — there is no CommonJS build.

## What the DSL supports

The DSL is a deliberately small subset of TypeScript type syntax, covering
**scalars only** - no arrays, no objects:

- **Primitives** - `string`, `number`, `bigint`, `boolean`, `undefined`
- **Literals** - `true`, `false`, numbers (`0`, `1`), strings (`'a'`, `"a"`,
  `` `a` ``)
- **Template literals** - `` `${number}${'%' | 'px'}` ``, with any nested
  scalar DSL inside `${...}`
- **Unions** - `"string | number | bigint | boolean | undefined"`
- **Recursive tokens** - a keyword can reference another DSL string
  (`"<length>"` -> `` "`${number}${'%' | 'px'}`" ``), with cycle detection

That restraint is what keeps the type-level parser small enough for one
maintainer to own and fast enough to stay out of your editor's way.

## Size

Measured, not aspirational:

- **613 lines** of source (`src/index.ts` + `src/types.ts`, **20.8 KB**, **6.0 KB
  gzipped**) — of which ~188 lines are the type-level parser and the rest the
  runtime parser.
- **10 exported symbols** — `SUPPORTED_KEYWORDS`, `dslString`,
  `parseValueAgainstDSL`, `extractTokenReferences`, `detectCircularReferences`,
  and the `DSLValidate` / `DSLValidateArm` / `DSLInfer` / `SupportedKeywords` /
  `SupportedKeywordsConfig` types.
- **~1.6 KB gzipped runtime** — once the type-level parser is erased, the
  runtime bundles to ~3.9 KB minified (~1.6 KB gzipped).
- Published tarball: **9.0 kB** packed / **28.4 kB** unpacked — `dist/` (the
  compiled ESM runtime plus its `.d.ts`) and this README. The `src/` sources are
  not shipped, and there is nothing for you to build.

This is a small parser over a deliberately small grammar — a scalar subset of
TypeScript type syntax, not a 1:1 port of TypeScript's compiler or runtime
validators.

## Autocomplete while typing

The type-level parser is autocomplete-aware: after a pipe, the union members
that match your keystrokes are suggested. `dslString(SUPPORTED_KEYWORDS,
"true | ````)` completes `` true | false ``. The `never` passed as the right
side is what triggers this (see the note on `PipeWhenExists`).

## Registered keywords

Anything in your keywords config is a valid token. `SUPPORTED_KEYWORDS` ships
with the primitives plus `true`/`false`; extend it with your own vocabulary:

```ts
const keywords = Object.assign({}, SUPPORTED_KEYWORDS, {
  "<length>": "`${number}${'%' | 'px'}`",
});
```

Keywords whose value is a non-empty string are **recursive tokens** - the
DSL string is resolved and parsed in place. `extractTokenReferences` finds
`<...>` references; `detectCircularReferences` rejects self-referencing or
cyclically-referencing token graphs.

## Known limits (deliberate)

- **Pipe inside single/double-quoted strings** (`"'|'"`) is not supported -
  the type-level parser splits on `|` before checking quote boundaries.
  Template literals (`` `|` ``) are exempt and work.
- **Nested template literals** (a backtick literal containing an interpolation)
  are not supported - tracking escape depth across quote contexts at the type
  level costs more than the edge case is worth.
- **No arrays or objects** - the DSL is scalar-only: primitives, literals,
  template literals, and their unions. Structural TypeScript syntax (`T[]`,
  `{ a: T }`) is out of scope. Supporting it would force the type-level parser
  to track bracket/brace nesting and structural recursion, which is exactly the
  complexity the scalar subset exists to avoid.

All three are documented trade-offs for type-system performance, not oversights.

## The two walls

| Wall          | What it catches                                                        |
| ------------- | --------------------------------------------------------------------- |
| Compile time  | A malformed DSL string fails `tsc` at the call site, with the offending token named. |
| Runtime       | `dslString()` throws on a malformed string even without `tsc` in the loop; `parseValueAgainstDSL()` rejects values that don't match. |

## Benchmarks

The type-level parser is measured, not guessed at. `bench/run.mjs` compiles each
scenario as its own program and reports TypeScript's **instantiation counts**
(`--singleThreaded`, so the counters are deterministic) - the unit that decides
whether a DSL string hits `TS2589` (too deep) or `TS2590` (union too complex):

- `pnpm bench` - scenario table plus break-point sweeps, diffed against the baseline
- `pnpm bench:baseline` - the same, and writes `bench/baseline.json`
- `pnpm bench:light` - scenario table only (fast, no sweeps)

Each implementation under test gets its own program directory
(`bench/.tmp/<impl>/`) with a per-scenario tsconfig, so an implementation never
shares a program or an incremental cache with the baseline.

The published package is cheaper to consume than the source, too: because `main`
resolves to a `.d.ts` rather than a `.ts`, the module is no longer type-checked
on every import (under the usual `skipLibCheck`), and the fixed instantiation
floor falls from **13,742** to **0**. You pay only for the DSL strings you
actually write.

## Prior art and lineage

The one-string, two-walls technique - a TypeScript-syntax definition string
parsed identically at the type level and at runtime - is the approach proven
by [ArkType](https://arktype.io). tsyntax applies it to a deliberately
smaller domain: scalar keyword unions, numbers, and template literals, with
**no arrays and no objects**. That restraint is what keeps the type-level
parser small enough for one maintainer to own and fast enough to stay out of
your editor's way.

You already know the DSL if you know TypeScript: `"'ltr' | 'rtl' |
undefined"` means exactly what it looks like.

## Status

Practically speaking done - Since the domain is constrainted. Issues are welcomed,
however I don't see a reason to further maintain this package so I expect 1.x.x
be the maximum version.

## Scoped alias

Prefer the plain name; if you need it under a scope, `@ace-code/tsyntax` is a
thin re-export of the same library (published from `packages/ace-code-tsyntax`
in this repo).

## License

MIT
