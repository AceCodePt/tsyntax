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
 * Each scenario is compiled as its own tiny program (`scenario + src`, no node
 * types, `skipLibCheck`) so the numbers isolate the DSL work instead of being
 * drowned by the rest of the repo. The compiler is pinned to
 * `--singleThreaded` because tsgo parallelises by default and the thread
 * scheduling makes whole-program counters jitter run to run; single-threaded
 * output is byte-for-byte deterministic.
 *
 * Output
 * ------
 *   pnpm perf            # scenario table + break-point sweeps, diffed vs baseline
 *   pnpm perf:baseline   # same, but writes perf/baseline.json
 *   pnpm perf:light      # scenario table only (fast, no sweeps)
 *
 * Flags: --save  --no-sweep  --regen
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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
const BASELINE = join(HERE, "baseline.json");
const TIMEOUT_MS = 120_000;

const FLAGS = new Set(process.argv.slice(2));
const SAVE = FLAGS.has("--save");
const SWEEP = !FLAGS.has("--no-sweep");
const REGEN = FLAGS.has("--regen");

const COMPILER_OPTIONS = {
  module: "NodeNext",
  moduleResolution: "NodeNext",
  target: "esnext",
  strict: true,
  noEmit: true,
  allowImportingTsExtensions: true,
  skipLibCheck: true,
  types: [],
};

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
    `import { SUPPORTED_KEYWORDS, type ${PARSER[kind]}, type SupportedKeywords } from "../../src/index.ts";\n` +
    `type K = ${K};\n` +
    `export type R = ${PARSER[kind]}<K, ${token}>;\n`
  );
}

// Near-wall input sizes, one per parser, tracking the walls reported by the
// `Break points` table below. Raise a number when that parser gets deeper, so
// "extreme" keeps measuring at the limit rather than comfortably under it.
const NEAR_WALL = {
  union: { infer: 92, validate: 49 },
  interp: { infer: 48, validate: 47 },
  interpUnion: { infer: 16, validate: 47 },
  templateArms: { infer: 48, validate: 49 },
};

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

function writeScenarios() {
  mkdirSync(SCEN_DIR, { recursive: true });
  writeFileSync(
    join(SCEN_DIR, "null.ts"),
    `import { SUPPORTED_KEYWORDS } from "../../src/index.ts";\nexport const baseline = SUPPORTED_KEYWORDS;\n`,
  );
  for (const { shape, kind } of SCENARIOS) {
    const body = source({ token: shape.token(kind), keywords: shape.keywords }, kind);
    writeFileSync(join(SCEN_DIR, `${shape.name}.${kind}.ts`), body);
  }
}

// ---------------------------------------------------------------------------
// Compilation + diagnostics parsing
// ---------------------------------------------------------------------------

function writeTsconfig(id, files) {
  const cfgPath = join(TMP_DIR, `tsconfig.${id}.json`);
  writeFileSync(cfgPath, JSON.stringify({ compilerOptions: COMPILER_OPTIONS, files }, null, 2));
  return cfgPath;
}

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

/** Compile an in-memory scenario source (used by sweeps). */
function measureSource(src, id) {
  writeFileSync(join(TMP_DIR, `${id}.ts`), src);
  return runTsc(writeTsconfig(id, [`${id}.ts`]));
}

function measureScenarios() {
  const results = {};
  results.null = runTsc(writeTsconfig("null", ["../scenarios/null.ts"]));
  for (const { key, shape, kind } of SCENARIOS) {
    const file = `${shape.name}.${kind}.ts`;
    results[key] = runTsc(writeTsconfig(key, [`../scenarios/${file}`]));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Break-point search
// ---------------------------------------------------------------------------

function findThreshold(dim, kind) {
  const cache = new Map();
  const at = (n) => {
    if (!cache.has(n)) {
      const src = source({ token: JSON.stringify(dim.gen(n)) }, kind);
      cache.set(n, measureSource(src, "sweep"));
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

mkdirSync(TMP_DIR, { recursive: true });
if (REGEN || !existsSync(join(SCEN_DIR, "null.ts"))) writeScenarios();

const base = !SAVE && existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;
const tscVersion = spawnSync(TSC, ["--version"], { encoding: "utf8" }).stdout.trim();
console.log(`tsyntax perf — ${tscVersion}${base ? `  (baseline: ${base.generatedAt})` : ""}`);

const scenarios = measureScenarios();
reportScenarios(scenarios, base);

let sweeps = null;
if (SWEEP) {
  sweeps = {};
  for (const dim of SWEEP_DIMS) {
    for (const kind of KINDS) sweeps[`${dim.name}.${kind}`] = findThreshold(dim, kind);
  }
  reportSweeps(sweeps, base);
}

if (SAVE) {
  writeFileSync(
    BASELINE,
    JSON.stringify(
      {
        tsc: tscVersion,
        generatedAt: new Date().toISOString(),
        scenarios: Object.fromEntries(
          Object.entries(scenarios).map(([k, v]) => [
            k,
            { instantiations: v.instantiations, types: v.types, ok: v.ok, codes: v.codes },
          ]),
        ),
        sweeps,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`\nSaved baseline -> ${BASELINE.replace(ROOT + "/", "")}`);
}

rmSync(TMP_DIR, { recursive: true, force: true });

const anyFailed = Object.values(scenarios).some((r) => !r.ok);
process.exit(anyFailed ? 1 : 0);
