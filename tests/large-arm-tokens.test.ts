import test, { describe } from "node:test";
import {
  dslString,
  parseValueAgainstDSL,
  SUPPORTED_KEYWORDS,
  type DSLInfer,
  type SupportedKeywords,
} from "@/index.ts";
import { assertType, type Equal } from "./type-utils.ts";
import assert from "node:assert";

// A token whose joined DSL string has 47 arms: the same arm count and arm
// *kinds* (template functions plus bare keywords) as the consumer's shipped
// `full`-tier `<color>`. That token was the reported `TS2589` trigger: an
// `InferCSSSyntax<..., "<color>">` call site exceeded TypeScript's
// instantiation-depth limit (100) once the joined string reached 47 arms.
//
// These tests pin the *semantics* the batched splitter must preserve for such a
// token -- correct union inference, internal template pipes kept intact within
// one arm, and runtime validation. The depth regression itself only reproduces
// inside the consumer's full config context, so it is verified there rather
// than here; these are the behavioural guards that context must keep holding.
const ARMS = [
  "`#${string}`",
  "`rgb(${number} ${number} ${number})`",
  "`rgb(${number} ${number} ${number} / ${number})`",
  "`rgb(${number}, ${number}, ${number})`",
  "`rgba(${number}, ${number}, ${number}, ${number})`",
  "`hsl(${number} ${number}% ${number}%)`",
  "`hsl(${number} ${number}% ${number}% / ${number})`",
  "`hsl(${number}, ${number}%, ${number}%)`",
  "`hsla(${number}, ${number}%, ${number}%, ${number})`",
  "`hwb(${number} ${number}% ${number}%)`",
  "`hwb(${number} ${number}% ${number}% / ${number})`",
  "`lab(${number} ${number} ${number})`",
  "`lab(${number} ${number} ${number} / ${number})`",
  "`lch(${number} ${number} ${number})`",
  "`lch(${number} ${number} ${number} / ${number})`",
  "`oklch(${number} ${number} ${number})`",
  "`oklch(${number} ${number} ${number} / ${number})`",
  "`oklab(${number} ${number} ${number})`",
  "`oklab(${number} ${number} ${number} / ${number})`",
  "`color(display-p3 ${number} ${number} ${number})`",
  "`color(srgb ${number} ${number} ${number})`",
  "`color(a98-rgb ${number} ${number} ${number})`",
  "`color(prophoto-rgb ${number} ${number} ${number})`",
  "`color(rec2020 ${number} ${number} ${number})`",
  "'transparent'",
  "'currentColor'",
  "'inherit'",
  "'initial'",
  "'unset'",
  "'black'",
  "'white'",
  "'red'",
  "'blue'",
  "'gray'",
  "'green'",
  "'yellow'",
  "'orange'",
  "'purple'",
  "'silver'",
  "'navy'",
  "'teal'",
  "'coral'",
  "'lime'",
  "'pink'",
  "'gold'",
  "'maroon'",
  "<var>",
] as const;

// The joined-string shape a config builder produces for the token: `arm | arm | ...`.
type JoinPostfix<
  T extends readonly string[],
  Acc extends string = "",
> = T extends readonly [infer H extends string, ...infer R extends string[]]
  ? JoinPostfix<R, Acc extends "" ? H : `${Acc} | ${H}`>
  : Acc;

type WithColor = SupportedKeywords & {
  "<var>": "`var(${string})`";
  "<color>": JoinPostfix<typeof ARMS>;
};

describe("large-arm tokens infer without exceeding the depth limit", () => {
  test("a 47-arm token reference infers (type-level)", () => {
    // The assertion is that this type *resolves*; a depth blow-up is a
    // compile error, so reaching this line with `tsc --noEmit` green is the
    // regression guard. Spot-check the inferred union.
    type Color = DSLInfer<WithColor, "<color>">;
    assertType<Equal<"red" extends Color ? true : false, true>>();
    assertType<Equal<"maroon" extends Color ? true : false, true>>();
    assertType<Equal<"transparent" extends Color ? true : false, true>>();
    // A template arm widens into the union.
    assertType<
      Equal<`oklch(${number} ${number} ${number})` extends Color ? true : false, true>
    >();
  });

  test("the 47-arm token still validates at runtime", () => {
    const config = Object.assign({}, SUPPORTED_KEYWORDS, {
      "<var>": "`var(${string})`",
      "<color>": ARMS.join(" | "),
    });
    dslString(config, "<color>");
    assert.strictEqual(
      parseValueAgainstDSL(config, "<color>", "red"),
      "red",
    );
    assert.strictEqual(
      parseValueAgainstDSL(config, "<color>", "oklch(0.5 0.1 200)"),
      "oklch(0.5 0.1 200)",
    );
  });

  test("a template arm keeps its internal pipe intact across the split", () => {
    // `steps(${number}, ${'start' | 'end'})` has a pipe inside the template; it
    // must stay one arm, not split into two at the inner `|`.
    type K = SupportedKeywords & {
      "<easing>": "`steps(${number}, ${'start' | 'end' | 'jump-start' | 'jump-end' | 'jump-none' | 'jump-both'})` | 'ease' | 'linear'";
    };
    type Easing = DSLInfer<K, "<easing>">;
    assertType<Equal<"ease" extends Easing ? true : false, true>>();
    assertType<Equal<"linear" extends Easing ? true : false, true>>();
    assertType<
      Equal<
        `steps(${number}, ${"start" | "end" | "jump-start" | "jump-end" | "jump-none" | "jump-both"})` extends Easing
          ? true
          : false,
        true
      >
    >();
  });
});
