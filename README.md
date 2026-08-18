# tsyntax

**tsyntax** - TypeScript-syntax **DSL strings**, parsed identically at the
**type level** and at **runtime**. One string, two walls.

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

Both are documented trade-offs for type-system performance, not oversights.

## The two walls

| Wall          | What it catches                                                        |
| ------------- | --------------------------------------------------------------------- |
| Compile time  | A malformed DSL string fails `tsc` at the call site, with the offending token named. |
| Runtime       | `dslString()` throws on a malformed string even without `tsc` in the loop; `parseValueAgainstDSL()` rejects values that don't match. |

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

Early, honest version: one maintainer, no releases yet. The type-level and
runtime guarantees above are tested (`pnpm test`). The API surface may still
move.

## License

MIT
