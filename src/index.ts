import type { Trim } from "./types.ts";

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

type DSLTemplateDelimiter<
  S extends SupportedKeywordsConfig,
  T extends string,
  Acc extends string = "",
> = Trim<T> extends `\`${infer Piped extends `${string}|${string}`}\`${infer Maybe extends string}`
  ? Maybe extends `${infer Before extends string}|${infer Other extends string}`
    ? DSLValidate<
        S,
        Other,
        `${Acc}${SingleDSLValidate<S, `\`${Piped}\``, never>}${HasTrailingSpace<Before> extends true ? " " : ""}|${HasLeadingSpace<Other> extends true ? " " : ""}`
      >
    : `${Acc}${SingleDSLValidate<S, `\`${Piped}\``, never>}`
  : T extends `${infer L extends string}|${infer R extends string}`
    ? DSLValidate<
        S,
        R,
        `${Acc}${SingleDSLValidate<S, L, never>}${HasTrailingSpace<L> extends true ? " " : ""}|${HasLeadingSpace<R> extends true ? " " : ""}`
      >
    : `${Acc}${SingleDSLValidate<S, T, never>}`;

// Walk the top-level `|` arms in tail position, accumulating the rebuilt string
// in `Acc`, so a long union no longer nests one frame per arm the way
// `PipeWhenExists`'s `…|${DSLValidate<S, R>}` did. Each arm is validated on its
// own (`SingleDSLValidate<…, never>`), and the `|` with the spaces either side
// of it is appended to `Acc` before the tail call. `Acc` defaults to `""`, so
// the two-argument `DSLValidate<K, T>` signature is unchanged.
//
// Unlike `DSLInfer`, the terminal is deliberately not guarded on
// `[Acc] extends [""]`. The guard would recover one step of scalar-template
// depth (the same step `DSLInfer` buys for +21 instantiations) but costs ~1,479
// instantiations of fixed cost here, because `DSLValidate` is referenced from
// the exported `dslString` signature and its body is therefore checked eagerly.
// One depth step is not worth that; the scalar-template validate walls sit one
// step below their infer counterparts as a result.
export type DSLValidate<
  Keywords extends SupportedKeywordsConfig,
  T extends string,
  Acc extends string = "",
> = [T] extends [never]
  ? string
  : Trim<T> extends `\`${string}\`${string}`
    ? DSLTemplateDelimiter<Keywords, T, Acc>
    : T extends `${infer L extends string}|${infer R extends string}`
      ? DSLValidate<
          Keywords,
          R,
          `${Acc}${SingleDSLValidate<Keywords, L, never>}${HasTrailingSpace<L> extends true ? " " : ""}|${HasLeadingSpace<R> extends true ? " " : ""}`
        >
      : `${Acc}${SingleDSLValidate<Keywords, T, never>}`;

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

// Peel arms lazily and accumulate the result as a union in tail position, so
// the recursion is tail-call-eliminated (deep, no tuple materialisation). No
// splitter, no mapped pass. A leading backtick is peeled first, so a `|` inside
// `${...}` stays within one arm. `Acc` starts as `never`, so `Acc | …` is the
// identity until the first arm is added.
//
// The final branch guards on `[Acc] extends [never]`: a token with no top-level
// `|` reaches the leaf with `Acc = never`, and returning `SingleDSLInfer`
// directly there (rather than `never | …`) keeps one instantiation frame off the
// path. That frame is what `InferRestOfBackTick` consumes per interpolation, so
// without the guard the deepest scalar-template tokens lose one step of depth.
export type DSLInfer<
  Keywords extends SupportedKeywordsConfig,
  Text extends string,
  Acc = never,
> = [Text] extends [never]
  ? string
  : string extends Text
    ? string
    : Trim<Text> extends `\`${infer Piped extends `${string}|${string}`}\`${infer Maybe extends string}`
      ? Piped extends `${infer Before extends string}\$\{${infer innerDSL extends string}\}${infer After extends string}`
        ?
            | Acc
            | `${Before}${DSLInfer<Keywords, Trim<innerDSL>>}${InferRestOfBackTick<Keywords, After>}`
            | DSLInfer<Keywords, Trim<Maybe>>
        : Acc | `${Piped}`
      : Text extends `${infer L}|${infer M}|${infer R}`
        ? DSLInfer<
            Keywords,
            Trim<R>,
            | Acc
            | SingleDSLInfer<Keywords, Trim<L>>
            | SingleDSLInfer<Keywords, Trim<M>>
          >
        : Text extends `${infer L}|${infer R}`
          ? DSLInfer<Keywords, Trim<R>, Acc | SingleDSLInfer<Keywords, Trim<L>>>
          : [Acc] extends [never]
            ? SingleDSLInfer<Keywords, Trim<Text>>
            : Acc | SingleDSLInfer<Keywords, Trim<Text>>;

function validateDSLPart(
  part: string,
  supportedKeywords: SupportedKeywordsConfig,
  fullDSL: string,
): void {
  const isKeyword = part in supportedKeywords;
  const isNumericLiteral = TS_NUMBER_RE.test(part);
  const isQuotedString = /^'[^']*'$|^"[^"]*"$|^`[^`]*`$/.test(part);
  const isTemplateLiteral = /^`.*`$/.test(part);

  if (
    !isKeyword &&
    !isNumericLiteral &&
    !isQuotedString &&
    !isTemplateLiteral
  ) {
    throw new Error(`Invalid DSL string: "${fullDSL}"`);
  }

  // Pipe inside single/double quoted strings is not supported — the type-level
  // parser splits on | before checking quote boundaries, so '|' would be
  // misinterpreted as a union. Template literals (`|`) are exempt because they
  // go through a separate type-level path that handles | correctly.
  const isSingleOrDoubleQuoted = /^'[^']*'$|^"[^"]*"$/.test(part);
  if (isSingleOrDoubleQuoted && part.slice(1, -1).includes("|")) {
    throw new Error(`Invalid DSL string: "${fullDSL}"`);
  }

  if (isTemplateLiteral && /\$\{/.test(part)) {
    const content = part.slice(1, -1);
    const interpolationRegex = /\$\{(.+?)\}/g;
    for (
      let match = interpolationRegex.exec(content);
      match;
      match = interpolationRegex.exec(content)
    ) {
      const innerDSL = match[1]!;
      const innerParts = splitOutsideQuotes(innerDSL).map((p) => p.trim());
      for (const innerPart of innerParts) {
        validateDSLPart(innerPart, supportedKeywords, fullDSL);
      }
    }
  }
}

export function dslString<
  const Keywords extends SupportedKeywordsConfig,
  const DSL extends string,
>(supportedKeywords: Keywords, dslString: DSLValidate<Keywords, DSL>) {
  const parts = splitOutsideQuotes(dslString).map((p) => p.trim());

  if (parts.length === 0 || (parts.length === 1 && parts[0] === "")) {
    throw new Error(`Invalid DSL string: "${dslString}"`);
  }

  for (const part of parts) {
    validateDSLPart(part, supportedKeywords, dslString);
  }

  return dslString;
}

export function extractTokenReferences(dsl: string): string[] {
  const tokens: string[] = [];
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;

  for (let i = 0; i < dsl.length; i++) {
    const ch = dsl[i];
    if (ch === "'" && !inDouble && !inBacktick) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && !inBacktick) inDouble = !inDouble;
    else if (ch === "`" && !inSingle && !inDouble) inBacktick = !inBacktick;
    else if (ch === "<" && !inSingle && !inDouble) {
      const end = dsl.indexOf(">", i);
      if (end !== -1) {
        tokens.push(dsl.slice(i, end + 1));
        i = end;
      }
    }
  }

  return tokens;
}

export function detectCircularReferences(config: Record<string, string>): void {
  for (const key in config) {
    const refs = extractTokenReferences(config[key]!);
    if (refs.includes(key)) {
      throw new Error(
        `Circular reference detected: token "${key}" references itself`,
      );
    }
  }

  const graph = new Map<string, string[]>();
  for (const key in config) {
    const refs = extractTokenReferences(config[key]!).filter(
      (ref) => ref in config && ref !== key,
    );
    graph.set(key, refs);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(node: string, path: string[]): void {
    visited.add(node);
    inStack.add(node);

    for (const neighbor of graph.get(node) ?? []) {
      if (!visited.has(neighbor)) {
        dfs(neighbor, [...path, neighbor]);
      } else if (inStack.has(neighbor)) {
        throw new Error(
          `Circular reference detected: ${path.join(" -> ")} -> ${neighbor}`,
        );
      }
    }

    inStack.delete(node);
  }

  for (const key of graph.keys()) {
    if (!visited.has(key)) {
      dfs(key, [key]);
    }
  }
}

function splitOutsideQuotes(dslString: string) {
  const parts = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;

  for (let i = 0; i < dslString.length; i++) {
    const ch = dslString[i];

    if (ch === "'" && !inDouble && !inBacktick) {
      inSingle = !inSingle;
      current += ch;
    } else if (ch === '"' && !inSingle && !inBacktick) {
      inDouble = !inDouble;
      current += ch;
    } else if (ch === "`" && !inSingle && !inDouble) {
      inBacktick = !inBacktick;
      current += ch;
    } else if (ch === "|" && !inSingle && !inDouble && !inBacktick) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }

  parts.push(current);

  return parts;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A TypeScript numeric literal - what `${number}` / `infer N extends number`
// accepts: optional sign, decimal (with an optional leading or trailing dot),
// hex/binary/octal, and an optional exponent. Deliberately not `Number(x)`,
// which also takes "Infinity" - `${number}` rejects that, so using `Number`
// here would make the two parsers disagree in the other direction.
const TS_NUMBER_PATTERN =
  "[+-]?(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?)";
const TS_NUMBER_RE = new RegExp(`^${TS_NUMBER_PATTERN}$`);

function dslTokenToRegExp(
  token: string,
  keywords: SupportedKeywordsConfig,
  seen: Set<string>,
): string | null {
  const trimmed = token.trim();
  if (trimmed === "string") return ".*";
  if (trimmed === "number") return TS_NUMBER_PATTERN;
  if (trimmed === "bigint") return "\\d+";
  if (trimmed === "boolean") return "(?:true|false)";
  if (trimmed === "true") return "true";
  if (trimmed === "false") return "false";
  if (trimmed === "undefined") return "undefined";
  if (trimmed.startsWith("`") && trimmed.endsWith("`")) {
    return templateFragment(trimmed.slice(1, -1), keywords, seen);
  }
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return escapeRegExp(trimmed.slice(1, -1));
  }
  // Recursive token reference such as <length>: compile the DSL it points at.
  // `seen` guards a cyclic config from looping forever.
  if (
    trimmed in keywords &&
    typeof keywords[trimmed] === "string" &&
    keywords[trimmed] !== ""
  ) {
    if (seen.has(trimmed)) return null;
    seen.add(trimmed);
    const fragment = dslToRegExpFragment(keywords[trimmed], keywords, seen);
    seen.delete(trimmed);
    return fragment;
  }
  if (TS_NUMBER_RE.test(trimmed)) return escapeRegExp(trimmed);
  return null;
}

// Unanchored fragment for a whole DSL string (a union or a single arm).
function dslToRegExpFragment(
  content: string,
  keywords: SupportedKeywordsConfig,
  seen: Set<string>,
): string | null {
  const alternatives: string[] = [];
  for (const token of splitOutsideQuotes(content)) {
    const fragment = dslTokenToRegExp(token, keywords, seen);
    if (fragment === null) return null;
    alternatives.push(fragment);
  }
  return alternatives.length > 0 ? `(?:${alternatives.join("|")})` : null;
}

// Unanchored fragment for the body of a template literal.
function templateFragment(
  template: string,
  keywords: SupportedKeywordsConfig,
  seen: Set<string>,
): string | null {
  let pattern = "";
  let index = 0;

  while (index < template.length) {
    if (template.charAt(index) === "$" && template.charAt(index + 1) === "{") {
      const end = template.indexOf("}", index + 2);
      if (end === -1) return null;
      const replacement = dslToRegExpFragment(
        template.slice(index + 2, end),
        keywords,
        seen,
      );
      if (replacement === null) return null;
      pattern += replacement;
      index = end + 1;
    } else {
      pattern += escapeRegExp(template.charAt(index));
      index += 1;
    }
  }

  return pattern;
}

function templateLiteralToRegExp(
  template: string,
  keywords: SupportedKeywordsConfig,
  seen: Set<string>,
): RegExp | null {
  const fragment = templateFragment(template, keywords, seen);
  return fragment === null ? null : new RegExp(`^${fragment}$`);
}

function matchValueAgainstPart(
  part: string,
  supportedKeywords: SupportedKeywordsConfig,
  checkAgainst: unknown,
): boolean {
  // Token reference / nested DSL: a keyword whose value is a non-empty DSL string
  if (
    part in supportedKeywords &&
    typeof supportedKeywords[part] === "string" &&
    supportedKeywords[part] !== ""
  ) {
    try {
      parseValueAgainstDSL(
        supportedKeywords,
        supportedKeywords[part],
        checkAgainst as never,
      );
      return true;
    } catch {
      return false;
    }
  }

  // Literal keyword such as true/false. Match by value, and crucially *before*
  // the typeof check below: `false` must not satisfy "true" (or vice versa)
  // just because both are booleans.
  if (part in supportedKeywords && String(supportedKeywords[part]) === part) {
    return checkAgainst === supportedKeywords[part];
  }

  // Primitive keyword (string/number/bigint/boolean/undefined): match by typeof
  if (
    part in supportedKeywords &&
    typeof checkAgainst === typeof supportedKeywords[part]
  ) {
    return true;
  }

  // Numeric literal, using TypeScript's numeric grammar - `Infinity`/`NaN` are
  // not literals, so they must not slip through the way `+part` would allow.
  if (TS_NUMBER_RE.test(part) && Number(part) === checkAgainst) {
    return true;
  }

  // String literal: 'value' or "value"
  if (
    (part.startsWith("'") && part.endsWith("'")) ||
    (part.startsWith('"') && part.endsWith('"'))
  ) {
    return checkAgainst === part.slice(1, -1);
  }

  // Template literal: compile to a regex and match the stringified value
  if (part.startsWith("`") && part.endsWith("`")) {
    const regExp = templateLiteralToRegExp(
      part.slice(1, -1),
      supportedKeywords,
      new Set(),
    );
    return regExp !== null && regExp.test(String(checkAgainst));
  }

  return false;
}

export function parseValueAgainstDSL<
  const Keywords extends SupportedKeywordsConfig,
  const DSL extends string,
>(
  supportedKeywords: Keywords, // { boolean: true, number: 0, true: true }
  dslString: DSLValidate<Keywords, DSL>, // 'true'
  checkAgainst: DSLInfer<Keywords, DSL>, // 'true'
): DSLInfer<Keywords, DSL> {
  // Validate the DSL string itself first (mirrors dslString() runtime check)
  const parts = splitOutsideQuotes(dslString).map((p) => p.trim());
  if (parts.length === 0 || (parts.length === 1 && parts[0] === "")) {
    throw new Error(`Invalid DSL string: "${dslString}"`);
  }
  for (const part of parts) {
    validateDSLPart(part, supportedKeywords, dslString);
  }

  const matches = parts.some((part) =>
    matchValueAgainstPart(part, supportedKeywords, checkAgainst),
  );

  if (!matches) {
    throw new Error(
      `Value of type "${typeof checkAgainst}" does not match DSL "${dslString}"`,
    );
  }

  return checkAgainst as DSLInfer<Keywords, DSL>;
}
