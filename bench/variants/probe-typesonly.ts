import type { Trim } from "../../src/types.ts";

const SUPPORTED_PRIMITIVES = {
  string: "" as string,
  number: 0 as number,
  bigint: BigInt(0) as bigint,
  boolean: true as boolean,
  undefined: undefined as undefined,
} as const;

const SUPPORTED_LITERALS = {
  true: true,
  false: false,
} as const;

export const SUPPORTED_KEYWORDS = Object.assign(
  {},
  SUPPORTED_PRIMITIVES,
  SUPPORTED_LITERALS,
);

export type SupportedKeywords = typeof SUPPORTED_KEYWORDS;

export interface SupportedKeywordsConfig {
  [attribute: string]: any;
}

type HasTrailingSpace<S extends string> = S extends `${string} ` ? true : false;
type HasLeadingSpace<S extends string> = [S] extends [never]
  ? false
  : S extends ` ${string}`
    ? true
    : false;

// Small note: the never for R is critical
// See example: dslString("string |") and auto complete after the pipe
type PipeWhenExists<
  S extends SupportedKeywordsConfig,
  L extends string | number,
  R extends string | never = never,
  SpaceBefore extends boolean = false,
  SpaceAfter extends boolean = false,
> = [R] extends [never]
  ? Trim<`${L}`>
  : `${Trim<`${L}`>}${SpaceBefore extends true ? " " : ""}|${SpaceAfter extends true ? " " : ""}${DSLValidate<S, R>}`;

type ValidateRestOfBackTick<
  Keywords extends SupportedKeywordsConfig,
  Str extends string | never,
> = Str extends `\$\{${infer innerDSL extends string}\}${infer Maybe extends string}`
  ? `\${${Trim<DSLValidate<Keywords, innerDSL>>}}${ValidateRestOfBackTick<Keywords, Maybe>}`
  : `${Str}`;

type SingleDSLValidate<
  Keywords extends SupportedKeywordsConfig,
  L extends string,
  R extends string | never,
  SpaceBefore extends boolean = HasTrailingSpace<L>,
  SpaceAfter extends boolean = HasLeadingSpace<R>,
> =
  Trim<L> extends `${infer N extends number}`
    ? PipeWhenExists<Keywords, N, R, SpaceBefore, SpaceAfter>
    : Trim<L> extends `\`${infer Str extends string}\``
      ? PipeWhenExists<
          Keywords,
          `\`${ValidateRestOfBackTick<Keywords, Str>}\``,
          R,
          SpaceBefore,
          SpaceAfter
        >
      : Trim<L> extends `'${string}'` | `"${string}"`
        ? PipeWhenExists<Keywords, L, R, SpaceBefore, SpaceAfter>
        : Trim<L> extends keyof Keywords
          ? PipeWhenExists<Keywords, Trim<L>, R, SpaceBefore, SpaceAfter>
          : [Extract<keyof Keywords, `${Trim<L>}${string}`>] extends [string]
            ? PipeWhenExists<
                Keywords,
                Extract<keyof Keywords, `${Trim<L>}${string}`>,
                R,
                SpaceBefore,
                SpaceAfter
              >
            : `'${Trim<L>}' is not supported`;

type DSLTemplateDelimiter<S extends SupportedKeywordsConfig, T extends string> =
  Trim<T> extends `\`${infer Piped extends `${string}|${string}`}\`${infer Maybe extends string}`
    ? Maybe extends `${infer Before extends string}|${infer Other extends string}`
      ? SingleDSLValidate<
          S,
          `\`${Piped}\``,
          Other,
          HasTrailingSpace<Before>,
          HasLeadingSpace<Other>
        >
      : SingleDSLValidate<S, `\`${Piped}\``, never>
    : T extends `${infer L extends string}|${infer R extends string}`
      ? SingleDSLValidate<S, L, R>
      : SingleDSLValidate<S, T, never>;

export type DSLValidate<
  Keywords extends SupportedKeywordsConfig,
  T extends string,
> = [T] extends [never]
  ? string
  : Trim<T> extends `\`${string}\`${string}`
    ? DSLTemplateDelimiter<Keywords, T>
    : T extends `${infer L extends string}|${infer R extends string}`
      ? SingleDSLValidate<Keywords, L, R>
      : SingleDSLValidate<Keywords, T, never>;

/**
 * Validates exactly one DSL arm - a single string with no top-level `|`
 * handling. Use this when validating an array of arms one element at a time
 * (e.g. `{ readonly [I in keyof Arms]: DSLValidateArm<Keywords, Arms[I] & string> }`),
 * where `DSLValidate`'s union splitting would misread a `|` inside an arm.
 * For an equivalent single-arm string it produces the same diagnostic shape
 * as `DSLValidate`.
 */
export type DSLValidateArm<
  Keywords extends SupportedKeywordsConfig,
  Arm extends string,
> = [Arm] extends [never] ? string : SingleDSLValidate<Keywords, Arm, never>;

type InferRestOfBackTick<
  Keywords extends SupportedKeywordsConfig,
  Str extends string,
> = Str extends `${infer Before extends string}\$\{${infer innerDSL extends string}\}${infer Rest extends string}`
  ? `${Before}${DSLInfer<Keywords, innerDSL>}${InferRestOfBackTick<Keywords, Rest>}`
  : `${Str}`;

type SingleDSLInfer<
  Keywords extends SupportedKeywordsConfig,
  Text extends string,
> = Text extends keyof Keywords
  ? Keywords[Text] extends string
    ? DSLInfer<Keywords, Keywords[Text]>
    : Keywords[Text]
  : Text extends `${infer N extends number}`
    ? N
    : Text extends `\`${infer Str extends string}\``
      ? InferRestOfBackTick<Keywords, Str>
      : Text extends
            | `'${infer Str extends string}'`
            | `"${infer Str extends string}"`
        ? Str
        : never;

// Split the joined string into its top-level arms (a leading backtick runs to
// its shortest closing backtick, so a `|` inside `${...}` stays within one
// arm), then hand the arm *union* to `DSLInfer` one arm at a time. No mapped
// type: distribution is forced by the naked `U` in `DistributeInfer`.
type SplitArms<
  S extends string,
  Accum extends readonly string[] = [],
> = Trim<S> extends ""
  ? Accum
  : SplitChunk<Trim<S>> extends [
        infer Chunk extends string[],
        infer Rest extends string,
      ]
    ? SplitArms<Rest, [...Accum, ...Chunk]>
    : Accum;

type SplitChunk<
  S extends string,
  Acc extends string[] = [],
> = Acc["length"] extends 8 ? [Acc, S] : SplitOne<S, Acc>;

type SplitOne<
  S extends string,
  Acc extends string[],
> = S extends `\`${infer Seg}\`${infer Rest}`
  ? SplitChunk<Rest, [...Acc, `\`${Seg}\``]>
  : S extends `${infer Seg}|${infer Rest}`
    ? SplitChunk<Rest, [...Acc, Trim<Seg>]>
    : [[...Acc, Trim<S>], ""];

// `U` is naked, so this distributes over the arm union and resolves each arm
// with the *existing* `DSLInfer` leaf logic — no bespoke per-arm resolver.
type DistributeInfer<
  Keywords extends SupportedKeywordsConfig,
  U extends string,
> = U extends string ? DSLInfer<Keywords, U> : never;

export type DSLInfer<
  Keywords extends SupportedKeywordsConfig,
  Text extends string,
> = [Text] extends [never]
  ? string
  : string extends Text
    ? string
    : Trim<Text> extends `\`${infer Piped extends `${string}|${string}`}\`${infer Maybe extends string}`
      ? Piped extends `${infer Before extends string}\$\{${infer innerDSL extends string}\}${infer After extends string}`
        ?
            | `${Before}${DSLInfer<Keywords, Trim<innerDSL>>}${InferRestOfBackTick<Keywords, After>}`
            | DSLInfer<Keywords, Trim<Maybe>>
        : `${Piped}`
      : Text extends `${string}|${string}`
        ? DistributeInfer<Keywords, SplitArms<Text>[number]>
        : SingleDSLInfer<Keywords, Trim<Text>>;

