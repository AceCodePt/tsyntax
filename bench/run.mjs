#!/usr/bin/env node
/**
 * tsyntax type-level cost harness.
 *
 * Measures how much type-system work the DSL parsers do, in the unit that
 * actually matters for editor latency and `TS2589`/`TS2590`: the compiler's
 * *Instantiation* count.
 *
 * `DSLValidate` and `DSLInfer` are separate parsers with different costs, so
 * every shape is measured twice — once per parser — and reported side by side.
 *
 * How it measures
 * ---------------
 * Each scenario is compiled as its own tiny program (one scenario + the chosen
 * implementation, no node types, `skipLibCheck`) so the numbers isolate the DSL
 * work instead of being drowned by the rest of the repo. The compiler is pinned
 * to `--singleThreaded` because tsgo parallelises by default and the thread
 * scheduling makes whole-program counters jitter run to run; single-threaded
 * output is byte-for-byte deterministic.
 *
 * Isolation
 * ---------
 * Scenarios import the implementation through the `@impl` alias. Each
 * implementation therefore gets its *own* program directory
 * (`bench/.tmp/<impl>/`) with, per scenario, its own `tsconfig` whose `include`
 * names exactly that one scenario file. Two implementations never share a
 * program, a tsconfig, or an incremental cache — `--impl src/index2.ts` is a
 * completely separate measurement from `--impl src/index.ts`.
 *
 * Output
 * ------
 *   pnpm bench            # scenario table + break-point sweeps, diffed vs baseline
 *   pnpm bench:baseline   # same, but writes bench/baseline.json
 *   pnpm bench:light      # scenario table only (fast, no sweeps)
 *
 * Flags
 * -----
 *   --impl <file>      implementation under test (default: src/index.ts)
 *   --baseline <file>  comparison baseline JSON (default: bench/baseline.json)
 *   --save             write the baseline instead of diffing against it
 *   --no-sweep         skip break-point sweeps
 *   --regen            regenerate the committed bench/scenarios/*.ts (the run
 *                      refuses to measure if they no longer match the generators)
 *   --keep-tmp         keep the generated program dir + tsconfigs for inspection
 *   --json [path|-]    save the result as JSON under bench/ (`bench/<variant>.json`
 *                      by default, so it never lands in the published src/); `-`
 *                      for stdout
 *
 * The provenance banner and run progress go to stderr, so `--json -` keeps
 * stdout pure JSON while still telling you what was measured.
 *
 * Example: measure index2 against the index baseline
 *   node bench/run.mjs --impl src/index2.ts --baseline bench/baseline.json
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TSC = join(
  ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsc.cmd" : "tsc",
);
const SCEN_DIR = join(HERE, "scenarios");
const TMP_DIR = join(HERE, ".tmp");
const TIMEOUT_MS = 120_000;

// The alias every scenario imports; the per-variant tsconfig `paths` maps it.
const IMPORT_SPEC = "@impl";

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const FLAGS = new Set(process.argv.slice(2));
const SAVE = FLAGS.has("--save");
const SWEEP = !FLAGS.has("--no-sweep");
const REGEN = FLAGS.has("--regen");
const KEEP_TMP = FLAGS.has("--keep-tmp");

const IMPL = argValue("--impl") ?? "src/index.ts";
const IMPL_ABS = resolve(ROOT, IMPL);
const VARIANT = basename(IMPL)
  .replace(/\.[^.]+$/, "")
  .replace(/[^a-zA-Z0-9_-]/g, "-");
const IMPL_TYPE_LABEL = VARIANT;

// `--json` saves the result as `<variant>.json` under the (ignored) bench dir —
// never next to the implementation, which for the default `src/index.ts` would
// drop a stray file into the published `files: ["src"]` tarball and the git
// tree. `--json <path>` overrides the target; `--json -` writes to stdout.
const jsonIdx = process.argv.indexOf("--json");
const JSON_OUT = jsonIdx >= 0;
const jsonArg = JSON_OUT ? process.argv[jsonIdx + 1] : undefined;
const JSON_TO_STDOUT = jsonArg === "-";
const JSON_PATH = !JSON_OUT
  ? null
  : JSON_TO_STDOUT
    ? null
    : jsonArg && !jsonArg.startsWith("-")
      ? resolve(process.cwd(), jsonArg)
      : join(HERE, `${VARIANT}.json`);

const BASELINE = argValue("--baseline")
  ? resolve(process.cwd(), argValue("--baseline"))
  : join(HERE, "baseline.json");

// Each implementation gets its own isolated program directory.
const VARIANT_DIR = join(TMP_DIR, VARIANT);

// The two parsers, kept deliberately distinct.
const KINDS = ["infer", "validate"];
const PARSER = { infer: "DSLInfer", validate: "DSLValidate" };

// ---------------------------------------------------------------------------
// Scenario source generation
// ---------------------------------------------------------------------------

// Frozen arm pool. Every `|`-width measurement draws from this so thresholds
// are comparable across runs. Mixes bare keywords with template-function arms
// because the two consume different amounts of instantiation depth.
const POOL = [
  "'red'",
  "'blue'",
  "'green'",
  "`rgb(${number})`",
  "`rgb(${number} ${number} ${number})`",
  "'transparent'",
  "'inherit'",
  "`hsl(${number}% ${number}%)`",
  "`hsl(${number} ${number}% ${number}% / ${number})`",
  "'black'",
  "`oklch(${number} ${number} ${number})`",
  "`color(srgb ${number} ${number} ${number})`",
];

const joinedArms = (n) =>
  Array.from({ length: n }, (_, i) => POOL[i % POOL.length]).join(" | ");

const interpScalar = (n) => "`" + "${number}".repeat(n) + "`";
const interpUnion = (n) => "`" + "${'a' | 'b'}".repeat(n) + "`";
const templateArms = (n) =>
  Array.from({ length: n }, () => "`${'a' | 'b'}`").join(" | ");

/** Build a scenario source: run `kind` on `token` against K. */
function source({ token, keywords = {} }, kind) {
  const extra = Object.entries(keywords)
    .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
    .join("\n");
  const K = Object.keys(keywords).length
    ? `SupportedKeywords & {\n${extra}\n}`
    : "SupportedKeywords";
  return (
    `import { type ${PARSER[kind]}, type SupportedKeywords } from "${IMPORT_SPEC}";\n` +
    `type K = ${K};\n` +
    `export type R = ${PARSER[kind]}<K, ${token}>;\n`
  );
}

const NULL_SOURCE =
  `import { SUPPORTED_KEYWORDS } from "${IMPORT_SPEC}";\n` +
  `export const baseline = SUPPORTED_KEYWORDS;\n`;

// Near-wall input sizes, one per parser, tracking the walls reported by the
// `Break points` table below. Raise a number when that parser gets deeper, so
// "extreme" keeps measuring at the limit rather than comfortably under it.
const NEAR_WALL = {
  union: { infer: 92, validate: 49 },
  interp: { infer: 48, validate: 47 },
  interpUnion: { infer: 16, validate: 47 },
  templateArms: { infer: 48, validate: 49 },
};

// Which scenario each `NEAR_WALL` entry builds, and which sweep dimension
// measures its wall. The two names differ (`extreme-interp` is the scenario,
// `interp-scalar` the dimension) — the pinned value is a *lower bound* on the
// wall: if a parser gets deeper the wall moves up and the pin stays valid; if
// the wall drops below the pin the extreme no longer compiles, and
// `checkNearWall` says so by scenario name instead of letting it look like a
// stray TS2589.
const NEAR_WALL_DIM = {
  union: { scenario: "extreme-union", dim: "union-width" },
  interp: { scenario: "extreme-interp", dim: "interp-scalar" },
  interpUnion: { scenario: "extreme-interp-union", dim: "interp-union" },
  templateArms: { scenario: "extreme-template-arms", dim: "template-arms" },
};

/** Compare every pinned extreme against the wall the current run measured. */
function checkNearWall(sweeps) {
  const problems = [];
  for (const [shape, { scenario, dim }] of Object.entries(NEAR_WALL_DIM)) {
    for (const kind of KINDS) {
      const pinned = NEAR_WALL[shape]?.[kind];
      const measured = sweeps?.[`${dim}.${kind}`]?.threshold;
      if (pinned == null || measured == null) continue;
      if (pinned > measured) {
        problems.push(
          `scenario ${scenario}.${kind} no longer compiles: NEAR_WALL.${shape} pins ${pinned}, but the ${dim}/${kind} wall is ${measured} — lower NEAR_WALL.${shape}.${kind} (or the parser regressed)`,
        );
      }
    }
  }
  return problems;
}

// Light shapes (cheap, always green) and extreme shapes (at each parser's wall).
// `token(kind)` -> the DSL string literal handed to that parser.
const SHAPES = [
  { name: "light-literal", token: () => JSON.stringify("'auto'") },
  {
    name: "light-union",
    token: () => JSON.stringify("'ltr' | 'rtl' | 'center' | 'justify'"),
  },
  { name: "light-template", token: () => JSON.stringify("`${number}${'%' | 'px'}`") },
  {
    name: "light-recursive-token",
    token: () => JSON.stringify("<length>"),
    keywords: { "<length>": "`${number}${'%' | 'px'}`" },
  },
  { name: "extreme-union", token: (k) => JSON.stringify(joinedArms(NEAR_WALL.union[k])) },
  { name: "extreme-interp", token: (k) => JSON.stringify(interpScalar(NEAR_WALL.interp[k])) },
  {
    name: "extreme-interp-union",
    token: (k) => JSON.stringify(interpUnion(NEAR_WALL.interpUnion[k])),
  },
  {
    name: "extreme-template-arms",
    token: (k) => JSON.stringify(templateArms(NEAR_WALL.templateArms[k])),
  },
];

// scenario key -> { shape, kind }; plus the shared `null` floor.
const SCENARIOS = SHAPES.flatMap((shape) =>
  KINDS.map((kind) => ({ key: `${shape.name}.${kind}`, shape, kind })),
);

const SWEEP_DIMS = [
  { name: "union-width", min: 2, max: 512, gen: joinedArms, unit: "arms" },
  { name: "interp-scalar", min: 1, max: 256, gen: interpScalar, unit: "interpolations" },
  { name: "interp-union", min: 1, max: 128, gen: interpUnion, unit: "interpolations" },
  { name: "template-arms", min: 1, max: 128, gen: templateArms, unit: "arms" },
];

// The committed `bench/scenarios/*.ts` are generated, but generated *once* —
// from the shapes and numbers above at whatever moment someone last ran
// `--regen`. Editing `SHAPES`/`NEAR_WALL`/`POOL` without regenerating would
// silently keep measuring the old fixtures, so the run always rebuilds the
// expected sources in memory and diffs them against what is on disk.
function expectedScenarioSources() {
  const sources = new Map([["null", NULL_SOURCE]]);
  for (const { shape, kind } of SCENARIOS) {
    sources.set(
      `${shape.name}.${kind}`,
      source({ token: shape.token(kind), keywords: shape.keywords }, kind),
    );
  }
  return sources;
}

function writeScenarios(sources) {
  mkdirSync(SCEN_DIR, { recursive: true });
  for (const [name, body] of sources) {
    writeFileSync(join(SCEN_DIR, `${name}.ts`), body);
  }
}

function staleScenarios(sources) {
  const stale = [];
  for (const [name, body] of sources) {
    const path = join(SCEN_DIR, `${name}.ts`);
    if (!existsSync(path) || readFileSync(path, "utf8") !== body) stale.push(name);
  }
  return stale;
}

// ---------------------------------------------------------------------------
// Isolated per-implementation programs
// ---------------------------------------------------------------------------

const rel = (p) => relative(VARIANT_DIR, p).split("\\").join("/");

function writeTsconfig(id, include) {
  const cfgPath = join(VARIANT_DIR, `tsconfig.${id}.json`);
  writeFileSync(
    cfgPath,
    JSON.stringify(
      {
        // Inherit the root compiler options ...
        extends: rel(join(ROOT, "tsconfig.json")),
        compilerOptions: {
          // ... but this program is hermetic: no ambient `node` types, and the
          // `@impl` alias points at the implementation under test. `paths` are
          // resolved relative to this file (TS7 removed `baseUrl`).
          types: [],
          paths: {
            "@/*": [rel(join(ROOT, "src", "*"))],
            [IMPORT_SPEC]: [rel(IMPL_ABS)],
          },
        },
        // Root excludes `bench`; this program *is* a file under bench/, so drop
        // that entry. `include` then names exactly the one file this program
        // is: no other scenario, no other implementation, nothing shared.
        exclude: ["node_modules", "dist"],
        include,
      },
      null,
      2,
    ),
  );
  return cfgPath;
}

/** Program (tsconfig) for one committed scenario file, isolated to that file. */
function scenarioProgram(key) {
  return writeTsconfig(key, [rel(join(SCEN_DIR, `${key}.ts`))]);
}

/** Program (tsconfig) for the in-memory sweep scenario, written into the dir. */
function sweepProgram(src) {
  writeFileSync(join(VARIANT_DIR, "sweep.ts"), src);
  return writeTsconfig("sweep", ["sweep.ts"]);
}

// ---------------------------------------------------------------------------
// Compilation + diagnostics parsing
// ---------------------------------------------------------------------------

function runTsc(cfgPath) {
  const res = spawnSync(
    TSC,
    ["-p", cfgPath, "--singleThreaded", "--extendedDiagnostics"],
    { cwd: ROOT, encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 },
  );
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const fields = {};
  for (const line of out.split("\n")) {
    const m = /^([A-Za-z][A-Za-z ]*):\s+(\S+)/.exec(line);
    if (m) fields[m[1].trim()] = m[2];
  }
  const codes = [...new Set([...out.matchAll(/error (TS\d+)/g)].map((x) => x[1]))];
  const timeout = res.error?.code === "ETIMEDOUT" || res.signal === "SIGTERM";
  return {
    instantiations: Number.parseInt(fields["Instantiations"] ?? "", 10) || 0,
    types: Number.parseInt(fields["Types"] ?? "", 10) || 0,
    check: fields["Check time"] ?? "?",
    total: fields["Total time"] ?? "?",
    codes,
    timeout,
    ok: !timeout && res.status === 0,
  };
}

function measureScenarios() {
  const results = {};
  results.null = runTsc(scenarioProgram("null"));
  for (const { key } of SCENARIOS) results[key] = runTsc(scenarioProgram(key));
  return results;
}

// ---------------------------------------------------------------------------
// Break-point search
// ---------------------------------------------------------------------------

function findThreshold(dim, kind) {
  process.stderr.write(`  · sweep ${dim.name}/${kind}\n`);
  const r = findThresholdInner(dim, kind);
  process.stderr.write(
    `    → wall ${r.threshold ?? "—"}${r.failCode ? ` ${r.failCode}` : ""}\n`,
  );
  return r;
}

function findThresholdInner(dim, kind) {
  const cache = new Map();
  const at = (n) => {
    if (!cache.has(n)) {
      const src = source({ token: JSON.stringify(dim.gen(n)) }, kind);
      cache.set(n, runTsc(sweepProgram(src)));
    }
    return cache.get(n);
  };

  if (!at(dim.min).ok) {
    return { threshold: null, failCode: at(dim.min).codes[0] ?? "ERR", unit: dim.unit };
  }
  let ok = dim.min;
  let failN = null;
  for (let n = dim.min; n < dim.max; ) {
    n = Math.min(n * 2, dim.max);
    if (!at(n).ok) {
      failN = n;
      break;
    }
    ok = n;
    if (n === dim.max) break;
  }
  if (failN === null) {
    const r = at(ok);
    return { threshold: ok, failCode: null, note: `>=${dim.max}`, instantiations: r.instantiations, unit: dim.unit };
  }
  let lo = ok;
  let hi = failN;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (at(mid).ok) lo = mid;
    else hi = mid;
  }
  return {
    threshold: lo,
    failCode: at(hi).codes[0] ?? "ERR",
    instantiations: at(lo).instantiations,
    unit: dim.unit,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function status(ok, codes, timedOut) {
  if (timedOut) return `${RED}TIMEOUT${RESET}`;
  if (ok) return `${GREEN}ok${RESET}`;
  return `${RED}${codes[0] ?? "ERR"}${RESET}`;
}

const fmt = (n) => n.toLocaleString("en-US");

// visible-length padding that ignores ANSI escapes
const vlen = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
const pad = (s, n, align = "start") => {
  const fill = " ".repeat(Math.max(0, n - vlen(s)));
  return align === "start" ? s + fill : fill + s;
};

function reportScenarios(results, base) {
  const floor = results.null?.instantiations ?? 0;
  console.log("\nScenarios (single-threaded, Instantiation counts)\n");
  console.log(
    "  " +
      pad("scenario", 26) +
      pad("parser", 10) +
      pad("instantiations", 15, "end") +
      pad("delta", 12, "end") +
      pad("types", 10, "end") +
      pad("check", 9, "end") +
      "  status",
  );
  console.log("  " + "-".repeat(90));
  const row = (label, parser, r, isFloor) => {
    const baseR = base?.scenarios?.[label === "null" ? "null" : `${label}.${parser}`];
    let delta = isFloor ? "—" : `+${fmt(r.instantiations - floor)}`;
    if (!isFloor && baseR) {
      const d = r.instantiations - baseR.instantiations;
      const color = d > 0 ? RED : d < 0 ? GREEN : DIM;
      delta = `${color}${d > 0 ? "+" : ""}${fmt(d)}${RESET}`;
    }
    console.log(
      "  " +
        pad(label, 26) +
        pad(parser, 10) +
        pad(fmt(r.instantiations), 15, "end") +
        pad(delta, 12, "end") +
        pad(fmt(r.types), 10, "end") +
        pad(r.check, 9, "end") +
        "  " +
        status(r.ok, r.codes, r.timeout),
    );
  };
  row("null", "—", results.null, true);
  for (const shape of SHAPES) {
    for (const kind of KINDS) row(shape.name, kind, results[`${shape.name}.${kind}`], false);
  }
}

function reportSweeps(sweeps, base) {
  console.log("\nBreak points (largest input that still compiles)\n");
  console.log(
    "  " +
      pad("dimension", 18) +
      pad("parser", 10) +
      pad("wall", 8, "end") +
      "  " +
      pad("error", 9) +
      pad("instantiations", 15, "end") +
      "  change",
  );
  console.log("  " + "-".repeat(84));
  for (const dim of SWEEP_DIMS) {
    for (const kind of KINDS) {
      const key = `${dim.name}.${kind}`;
      const r = sweeps[key];
      const baseR = base?.sweeps?.[key];
      const wall = r.threshold === null ? "0" : `${r.threshold}`;
      let change = "";
      if (baseR?.threshold != null && r.threshold != null && baseR.threshold !== r.threshold) {
        const d = r.threshold - baseR.threshold;
        change = `${d > 0 ? GREEN : RED}${d > 0 ? "+" : ""}${d} ${r.unit}${RESET}`;
      }
      console.log(
        "  " +
          pad(dim.name, 18) +
          pad(kind, 10) +
          pad(wall, 8, "end") +
          "  " +
          pad(r.failCode ?? r.note ?? "—", 9) +
          pad(r.instantiations != null ? fmt(r.instantiations) : "—", 15, "end") +
          "  " +
          change,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (!existsSync(IMPL_ABS)) {
  console.error(`implementation not found: ${IMPL} (resolved ${IMPL_ABS})`);
  process.exit(2);
}

mkdirSync(VARIANT_DIR, { recursive: true });
const sources = expectedScenarioSources();
if (REGEN) writeScenarios(sources);
const stale = staleScenarios(sources);
if (stale.length) {
  console.error(
    `bench: ${stale.length} committed scenario${stale.length === 1 ? "" : "s"} no longer match the generators: ${stale.slice(0, 4).join(", ")}${stale.length > 4 ? ", …" : ""}`,
  );
  console.error("bench: run `node bench/run.mjs --regen` to regenerate them.");
  process.exit(2);
}

const base = !SAVE && existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;
const tscVersion = spawnSync(TSC, ["--version"], { encoding: "utf8" }).stdout.trim();
// Provenance always on stderr, so a stdout-JSON run still says what it measured.
process.stderr.write(`tsyntax bench — ${tscVersion}\n`);
process.stderr.write(`  impl:     ${IMPL}  (variant "${VARIANT}")\n`);
if (base) {
  process.stderr.write(
    `  baseline: ${relative(ROOT, BASELINE)}  [${base.implLabel ?? base.impl ?? "?"}]\n`,
  );
}

process.stderr.write(`  · scenarios (${SCENARIOS.length + 1})\n`);
const scenarios = measureScenarios();
if (!JSON_TO_STDOUT) reportScenarios(scenarios, base);

let sweeps = null;
if (SWEEP) {
  sweeps = {};
  for (const dim of SWEEP_DIMS) {
    for (const kind of KINDS) sweeps[`${dim.name}.${kind}`] = findThreshold(dim, kind);
  }
  if (!JSON_TO_STDOUT) reportSweeps(sweeps, base);
}

// The pinned extremes are only meaningful while they sit at or under the wall
// the run just measured; anything past it is a stale pin, not a parser bug.
const nearWallProblems = checkNearWall(sweeps);
for (const problem of nearWallProblems) {
  console.error(`bench: NEAR_WALL ${problem}`);
}

const floor = scenarios.null?.instantiations ?? 0;
const scenarioPayload = Object.fromEntries(
  Object.entries(scenarios).map(([k, v]) => {
    const baseR = base?.scenarios?.[k];
    return [
      k,
      {
        instantiations: v.instantiations,
        types: v.types,
        check: v.check,
        total: v.total,
        ok: v.ok,
        codes: v.codes,
        deltaVsNull: k === "null" ? 0 : v.instantiations - floor,
        deltaVsBaseline: baseR ? v.instantiations - baseR.instantiations : null,
      },
    ];
  }),
);
const sweepPayload = sweeps
  ? Object.fromEntries(
      Object.entries(sweeps).map(([k, v]) => {
        const baseR = base?.sweeps?.[k];
        return [
          k,
          {
            ...v,
            deltaVsBaseline:
              baseR?.threshold != null && v.threshold != null
                ? v.threshold - baseR.threshold
                : null,
          },
        ];
      }),
    )
  : null;

// One schema for both `--save` (baseline) and `--json` (result): the baseline
// is just this same document for a given implementation, `bench/baseline.json`
// matching `bench/variants/<name>.json` field for field.
const payload = {
  tsc: tscVersion,
  impl: IMPL,
  implLabel: IMPL_TYPE_LABEL,
  variant: VARIANT,
  generatedAt: new Date().toISOString(),
  baseline: base ? relative(ROOT, BASELINE) : null,
  baselineImpl: base ? (base.implLabel ?? base.impl ?? null) : null,
  scenarios: scenarioPayload,
  sweeps: sweepPayload,
  nearWallProblems,
};

if (SAVE) {
  writeFileSync(BASELINE, JSON.stringify(payload, null, 2) + "\n");
  console.error(`Saved baseline -> ${relative(ROOT, BASELINE)}`);
}

if (JSON_OUT) {
  const jsonText = JSON.stringify(payload, null, 2) + "\n";
  if (JSON_TO_STDOUT) {
    process.stdout.write(jsonText);
  } else {
    writeFileSync(JSON_PATH, jsonText);
    const shown = relative(ROOT, JSON_PATH);
    console.error(`Saved JSON -> ${shown.startsWith("..") ? JSON_PATH : shown}`);
  }
}

if (KEEP_TMP) {
  console.error(`\nKept programs under ${relative(ROOT, VARIANT_DIR)}`);
} else {
  rmSync(TMP_DIR, { recursive: true, force: true });
}

const anyFailed = Object.values(scenarios).some((r) => !r.ok);
process.exit(anyFailed || nearWallProblems.length ? 1 : 0);