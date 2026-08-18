import test, { describe } from "node:test";
import { dslString, parseValueAgainstDSL, SUPPORTED_KEYWORDS } from "../src/index.ts";
import assert from "node:assert";

describe("@ace-code/tsyntax re-exports tsyntax", () => {
  test("SUPPORTED_KEYWORDS and dslString pass through", () => {
    assert.strictEqual(dslString(SUPPORTED_KEYWORDS, "string"), "string");
  });

  test("parseValueAgainstDSL still validates", () => {
    assert.strictEqual(
      parseValueAgainstDSL(SUPPORTED_KEYWORDS, "'ltr' | 'rtl'", "rtl"),
      "rtl",
    );
    assert.throws(() =>
      // @ts-expect-error
      parseValueAgainstDSL(SUPPORTED_KEYWORDS, "'ltr' | 'rtl'", "center"),
    );
  });
});
