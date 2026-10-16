#!/usr/bin/env node
/**
 * Pack smoke test - the one check the test suite cannot make.
 *
 * Every other test here runs under `tsx`, which compiles TypeScript on the fly
 * and therefore happily imports a `main` that points at a `.ts` file. A user's
 * plain `node` will not: it throws ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING.
 * That is exactly how tsyntax 1.1.3 shipped unusable to Node (and `require`,
 * and every JS consumer).
 *
 * So this script packs both packages the way `npm publish` would, extracts them
 * into a throwaway `node_modules`, and asserts on the *artifact*:
 *
 *   1. each tarball ships `dist/` only - no `.ts` source - but a `.d.ts`;
 *   2. `import "tsyntax"` works under plain `node` (no loader, no tsx);
 *   3. `@ace-code/tsyntax` re-exports it;
 *   4. a consumer type-checks against the shipped declarations, and an unknown
 *      token still fails to compile with the pointed message.
 *
 * Tarballs are produced locally, so this needs no network.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALIAS = join(ROOT, "packages", "ace-code-tsyntax");
const TSC = join(
  ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsc.cmd" : "tsc",
);

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
}

function fail(message) {
  console.error(`\n✖ package smoke test failed: ${message}`);
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "tsyntax-pack-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

// -- 1. pack, and assert the file list ---------------------------------------
const PACKAGES = [
  { dir: ROOT, name: "tsyntax" },
  { dir: ALIAS, name: "@ace-code/tsyntax" },
];
const tarballs = new Map();

for (const { dir, name } of PACKAGES) {
  const out = run(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", tmp],
    { cwd: dir },
  );
  // npm >= 11 reports an object keyed by package name; older npm, an array.
  const report = JSON.parse(out);
  const meta = Array.isArray(report) ? report[0] : Object.values(report)[0];
  const files = meta.files.map((f) => f.path);

  if (!files.includes("dist/index.js"))
    fail(`${name}: tarball has no dist/index.js (got: ${files.join(", ")})`);
  if (!files.includes("dist/index.d.ts"))
    fail(`${name}: tarball has no dist/index.d.ts`);
  const leaked = files.filter((f) => f.startsWith("src/"));
  if (leaked.length)
    fail(`${name}: tarball still ships TypeScript source: ${leaked.join(", ")}`);

  tarballs.set(name, join(tmp, meta.filename));
  console.log(`  · packed ${name}@${meta.version} (${meta.size} B, ${files.length} files)`);
}

// -- 2. extract into a throwaway node_modules --------------------------------
function extract(name, dest) {
  mkdirSync(dest, { recursive: true });
  run("tar", ["-xzf", tarballs.get(name), "-C", dest, "--strip-components=1"]);
}
extract("tsyntax", join(tmp, "node_modules", "tsyntax"));
extract("@ace-code/tsyntax", join(tmp, "node_modules", "@ace-code", "tsyntax"));
writeFileSync(
  join(tmp, "package.json"),
  JSON.stringify({ type: "module" }, null, 2) + "\n",
);

// -- 3. plain Node must import it --------------------------------------------
writeFileSync(
  join(tmp, "runtime.mjs"),
  `import assert from "node:assert/strict";

const m = await import("tsyntax");
assert.deepEqual(Object.keys(m).sort(), [
  "SUPPORTED_KEYWORDS",
  "detectCircularReferences",
  "dslString",
  "extractTokenReferences",
  "parseValueAgainstDSL",
]);
assert.equal(m.dslString(m.SUPPORTED_KEYWORDS, "string | number"), "string | number");
assert.throws(
  () => m.parseValueAgainstDSL(m.SUPPORTED_KEYWORDS, "string", 5),
  /does not match DSL/,
);

const alias = await import("@ace-code/tsyntax");
assert.equal(alias.dslString, m.dslString);
console.log("  · plain node import ok (tsyntax + @ace-code/tsyntax)");
`,
);
run("node", [join(tmp, "runtime.mjs")], { stdio: ["ignore", "inherit", "inherit"] });

// -- 4. a consumer must type-check against the shipped declarations ----------
const tscArgs = (file) => [
  file,
  "--noEmit",
  "--strict",
  "--module",
  "nodenext",
  "--moduleResolution",
  "nodenext",
  "--target",
  "esnext",
  "--pretty",
  "false",
];

writeFileSync(
  join(tmp, "ok.ts"),
  `import { dslString, SUPPORTED_KEYWORDS } from "tsyntax";
import type { DSLInfer } from "tsyntax";

type T = DSLInfer<typeof SUPPORTED_KEYWORDS, "'ltr' | 'rtl' | undefined">;
const dir: T = "rtl";
void dslString(SUPPORTED_KEYWORDS, "string | number"), dir;
`,
);
run(TSC, tscArgs(join(tmp, "ok.ts")), { cwd: tmp });

writeFileSync(
  join(tmp, "bad.ts"),
  `import { dslString, SUPPORTED_KEYWORDS } from "tsyntax";
dslString(SUPPORTED_KEYWORDS, "xyz");
`,
);
let badOutput = null;
try {
  run(TSC, tscArgs(join(tmp, "bad.ts")), { cwd: tmp });
} catch (err) {
  badOutput = `${err.stdout ?? ""}${err.stderr ?? ""}`;
}
if (badOutput === null)
  fail('the shipped declarations accepted `dslString(K, "xyz")` - the pointed error is gone');
if (!badOutput.includes("is not supported"))
  fail(`unexpected error for an unknown token:\n${badOutput}`);

console.log("  · consumer type-check ok (the pointed error survived the build)\n✔ package smoke test passed");
