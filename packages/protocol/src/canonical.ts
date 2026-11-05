// Canonical JSON: a small subset of RFC 8785 (JCS), docs/event-log.md section 3.
// Keys sorted by UTF-16 code unit, no whitespace, strings through JSON.stringify,
// numbers in ECMAScript shortest round trip, arrays keep their order.
// Stricter than RFC 8785 on purpose: -0 throws instead of printing "0", and anything
// that is not plain JSON data throws before it can reach a hash.

export class CanonicalError extends TypeError {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`canonical: ${message} at ${path}`);
    this.name = "CanonicalError";
    this.path = path;
  }
}

function tag(value: object): string {
  return Object.prototype.toString.call(value);
}

function serializeString(value: string, path: string): string {
  if (!value.isWellFormed()) throw new CanonicalError(path, "lone surrogate in string");
  return JSON.stringify(value);
}

function serializeNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) throw new CanonicalError(path, `non-finite number ${value}`);
  if (Object.is(value, -0)) throw new CanonicalError(path, "negative zero");
  return String(value);
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return (proto === Object.prototype || proto === null) && tag(value) === "[object Object]";
}

function serialize(value: unknown, path: string, stack: object[]): string {
  switch (typeof value) {
    case "string":
      return serializeString(value, path);
    case "number":
      return serializeNumber(value, path);
    case "boolean":
      return value ? "true" : "false";
    case "object":
      break;
    default:
      // undefined, function, bigint, symbol
      throw new CanonicalError(path, `unsupported ${typeof value}`);
  }
  if (value === null) return "null";
  if (stack.includes(value)) throw new CanonicalError(path, "cycle");

  if (Array.isArray(value)) {
    stack.push(value);
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) throw new CanonicalError(`${path}[${i}]`, "sparse array hole");
      parts.push(serialize(value[i], `${path}[${i}]`, stack));
    }
    stack.pop();
    return `[${parts.join(",")}]`;
  }

  if (!isPlainObject(value)) throw new CanonicalError(path, `unsupported ${tag(value)}`);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new CanonicalError(path, "symbol key");
  }
  stack.push(value);
  // Default sort compares UTF-16 code units, as RFC 8785 section 3.2.3 requires.
  const keys = Object.keys(value).sort();
  const record = value as Record<string, unknown>;
  const parts = keys.map((key) => {
    const childPath = `${path}.${key}`;
    return `${serializeString(key, childPath)}:${serialize(record[key], childPath, stack)}`;
  });
  stack.pop();
  return `{${parts.join(",")}}`;
}

/** Canonical JSON text of plain JSON data. Throws CanonicalError on any rejected value. */
export function canonicalize(value: unknown): string {
  return serialize(value, "$", []);
}
