/**
 * The frozen canonical JSON profile of ADR-0015 phase 0b (issue #11 item 3):
 * RFC 8785 (JSON Canonicalization Scheme) restricted to data every planned
 * implementation (Node today, Rust behind the phase 1 engine seam) can
 * serialize byte-identically without floating-point formatting rules. Object
 * member names are sorted by UTF-16 code units, strings are escaped exactly
 * as JSON.stringify escapes them, and the value space is booleans, null,
 * arrays, plain objects, and integers within the safe range. Non-integer
 * numbers, negative zero, unsafe integers, and non-JSON values are refused
 * rather than approximated. The profile specification, the encoder registry,
 * and the shared cross-implementation test vectors live in
 * docs/canonical-json/.
 */
export const CANONICAL_JSON_PROFILE = "vcs-lab.canonical-json/v1";

export function canonicalJson(value) {
  return serialize(value, "$");
}

function serialize(value, path) {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return serializeInteger(value, path);
    case "object":
      break;
    default:
      throw new TypeError(
        `${path} is a ${typeof value}; ${CANONICAL_JSON_PROFILE} accepts only JSON data`,
      );
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item, index) => serialize(item, `${path}[${index}]`))
      .join(",")}]`;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(
      `${path} is not a plain object; ${CANONICAL_JSON_PROFILE} accepts only JSON data`,
    );
  }
  // Array.prototype.sort compares strings by UTF-16 code units, which is
  // exactly the member ordering RFC 8785 requires.
  const members = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serialize(value[key], `${path}.${key}`)}`);
  return `{${members.join(",")}}`;
}

function serializeInteger(value, path) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      `${path} is ${value}; ${CANONICAL_JSON_PROFILE} accepts only integers with a magnitude of at most 2^53 - 1`,
    );
  }
  if (Object.is(value, -0)) {
    throw new TypeError(
      `${path} is negative zero; ${CANONICAL_JSON_PROFILE} forbids it because serialization would lose the sign`,
    );
  }
  return String(value);
}
