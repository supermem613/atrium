import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { z } from "zod";
import { scalarOrArray, lenientInt, lenientBool } from "../../src/mcp/lenient.js";

describe("scalarOrArray", () => {
  const schema = scalarOrArray(z.string());

  it("wraps a lone value into a single-element array", () => {
    assert.deepStrictEqual(schema.parse("x"), ["x"]);
  });

  it("passes an array through unchanged", () => {
    assert.deepStrictEqual(schema.parse(["a", "b"]), ["a", "b"]);
  });

  it("never whitespace-splits a lone string", () => {
    assert.deepStrictEqual(schema.parse("a b"), ["a b"]);
  });

  it("rejects an empty array only when nonEmpty is set", () => {
    assert.deepStrictEqual(scalarOrArray(z.string()).parse([]), []);
    const nonEmpty = scalarOrArray(z.string(), { nonEmpty: true });
    assert.deepStrictEqual(nonEmpty.parse("x"), ["x"]);
    assert.deepStrictEqual(nonEmpty.parse(["a", "b"]), ["a", "b"]);
    assert.throws(() => nonEmpty.parse([]));
  });
});

describe("lenientInt", () => {
  it("converts a numeric string to an integer", () => {
    assert.strictEqual(lenientInt({ positive: true }).parse("12"), 12);
  });

  it("rejects non-integer, non-numeric, and non-string junk", () => {
    const schema = lenientInt({ positive: true });
    for (const bad of ["1.5", "abc", null, [], true]) {
      assert.throws(() => schema.parse(bad));
    }
  });

  it("rejects zero and negatives when positive", () => {
    const schema = lenientInt({ positive: true });
    assert.throws(() => schema.parse(0));
    assert.throws(() => schema.parse(-3));
    assert.throws(() => schema.parse("-3"));
  });

  it("accepts zero when nonnegative", () => {
    assert.strictEqual(lenientInt({ nonnegative: true }).parse("0"), 0);
  });
});

describe("lenientBool", () => {
  it("maps the truthy string forms to true", () => {
    assert.strictEqual(lenientBool.parse("true"), true);
    assert.strictEqual(lenientBool.parse("1"), true);
  });

  it("maps the falsy string forms to false", () => {
    assert.strictEqual(lenientBool.parse("false"), false);
    assert.strictEqual(lenientBool.parse("0"), false);
  });

  it("rejects other values", () => {
    for (const bad of ["yes", 2, null]) {
      assert.throws(() => lenientBool.parse(bad));
    }
  });
});
