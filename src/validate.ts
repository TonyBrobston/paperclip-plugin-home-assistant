/**
 * Small dependency-free parameter validation.
 *
 * A schema library would be the obvious choice, but every runtime dependency
 * has to be inlined into the worker bundle, and these shapes are simple enough
 * that hand-rolled checks stay readable. The important property is the same as
 * a schema library's: unknown keys are rejected rather than ignored, so a
 * caller cannot smuggle an extra field into a request body.
 */

export class InvalidParameterError extends Error {}

function fail(message: string): never {
  throw new InvalidParameterError(message);
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    fail("Parameters must be an object.");
  }
  return value as Record<string, unknown>;
}

/**
 * Reject keys the tool does not declare.
 *
 * Silently dropping them would let a caller believe an unsupported filter had
 * been applied — a wrong answer that looks like a right one.
 */
export function rejectUnknownKeys(
  params: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(params).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    fail(
      `Unsupported parameter${unknown.length > 1 ? "s" : ""}: ${unknown.sort().join(", ")}. Supported: ${[...allowed].sort().join(", ")}.`,
    );
  }
}

export function optionalString(
  params: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") fail(`"${key}" must be a string.`);
  if (value.length > maxLength) {
    fail(`"${key}" must be at most ${maxLength} characters.`);
  }
  return value;
}

export function requiredString(
  params: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  const value = optionalString(params, key, maxLength);
  if (value === undefined || value.trim() === "") {
    fail(`"${key}" is required.`);
  }
  return value;
}

export function optionalBoolean(
  params: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") fail(`"${key}" must be true or false.`);
  return value;
}

export function optionalInteger(
  params: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(`"${key}" must be an integer.`);
  }
  if (value < min || value > max) {
    fail(`"${key}" must be between ${min} and ${max}.`);
  }
  return value;
}

/**
 * An ISO 8601 instant. Home Assistant puts these in the request *path* for
 * history and logbook, so an unparseable value would build a nonsense URL.
 */
export function optionalTimestamp(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = optionalString(params, key, 64);
  if (value === undefined) return undefined;
  if (!Number.isFinite(Date.parse(value))) {
    fail(`"${key}" must be an ISO 8601 date-time, such as 2026-10-14T08:00:00Z.`);
  }
  return value;
}

/** An entity ID such as `light.kitchen`. */
export function entityId(value: string, key: string): string {
  if (value.length > 255) fail(`"${key}" must be at most 255 characters.`);
  if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(value)) {
    fail(
      `"${key}" must be a Home Assistant entity ID such as light.kitchen or sensor.outdoor_temperature.`,
    );
  }
  return value;
}

/** A Home Assistant domain such as `light` or `binary_sensor`. */
export function domain(value: string, key: string): string {
  if (!/^[a-z0-9_]{1,64}$/.test(value)) {
    fail(`"${key}" must be a Home Assistant domain such as light or binary_sensor.`);
  }
  return value;
}
