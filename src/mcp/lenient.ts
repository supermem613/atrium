import { z } from "zod";

// Accepts either one item or an array of items and always yields an array, so a
// caller may omit the array wrapper for a single value. The advertised schema is
// the flat union so a reader sees both accepted forms. The preprocess step
// guarantees the parsed value is always an array, which is why the output type is
// narrowed to Item[]. A lone value is wrapped as one element and is never split
// on whitespace, preserving the rule that one argument is one argument. Set
// nonEmpty to require at least one element, which rejects an explicit empty array
// while still accepting a lone value.
export function scalarOrArray<Item extends z.ZodTypeAny>(
  item: Item,
  options: { nonEmpty?: boolean } = {},
): z.ZodEffects<z.ZodUnion<[Item, z.ZodArray<Item>]>, z.infer<Item>[], unknown> {
  const array = options.nonEmpty ? z.array(item).min(1) : z.array(item);
  return z.preprocess(
    (value) => (Array.isArray(value) ? value : [value]),
    z.union([item, array]),
  ) as z.ZodEffects<z.ZodUnion<[Item, z.ZodArray<Item>]>, z.infer<Item>[], unknown>;
}

export function scalarOrArrayInput<Item extends z.ZodTypeAny>(
  item: Item,
  options: { nonEmpty?: boolean } = {},
): z.ZodUnion<[Item, z.ZodArray<Item>]> {
  const array = options.nonEmpty ? z.array(item).min(1) : z.array(item);
  return z.union([item, array]) as z.ZodUnion<[Item, z.ZodArray<Item>]>;
}

export interface LenientIntOptions {
  positive?: boolean;
  nonnegative?: boolean;
}

// Accepts an integer or an integer-shaped string and yields a number. Only a
// string of optional sign and digits is converted. Everything else passes
// through unchanged to the strict integer schema so fractional strings, words,
// null, arrays, and booleans still reject. z.coerce is deliberately avoided
// because it would turn null, arrays, and booleans into numbers.
export function lenientInt(options: LenientIntOptions = {}) {
  let inner = z.number().int();
  if (options.positive) {
    inner = inner.positive();
  }
  if (options.nonnegative) {
    inner = inner.nonnegative();
  }
  return z.preprocess(
    (value) => (typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value),
    inner,
  );
}

// Accepts a boolean or one of the explicit string forms and yields a boolean.
// Only "true"/"1" and "false"/"0" map; every other value passes through to the
// strict boolean schema and rejects. z.coerce.boolean is deliberately avoided
// because it would treat the string "false" as true.
export const lenientBool = z.preprocess(
  (value) => {
    if (value === "true" || value === "1") {
      return true;
    }
    if (value === "false" || value === "0") {
      return false;
    }
    return value;
  },
  z.boolean(),
);
