/**
 * Small, dependency-free building blocks for runtime type guards.
 * They are exported so consumers can compose their own guards too.
 */

/** A runtime type guard. */
export type Guard<T> = (value: unknown) => value is T;

/** Extracts the guarded type from a {@link Guard}. */
export type GuardedType<G> = G extends Guard<infer T> ? T : never;

/** Checks that a value is a non-null, non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const isString: Guard<string> = (value): value is string => typeof value === 'string';

/** Checks for a finite number (rejects `NaN` and `Infinity`). */
export const isNumber: Guard<number> = (value): value is number =>
	typeof value === 'number' && Number.isFinite(value);

/** Checks for a finite integer. */
export const isInteger: Guard<number> = (value): value is number => Number.isInteger(value);

export const isBoolean: Guard<boolean> = (value): value is boolean => typeof value === 'boolean';

/** Accepts `undefined` or a value matching `guard`. */
export function optional<T>(guard: Guard<T>): Guard<T | undefined> {
	return (value): value is T | undefined => value === undefined || guard(value);
}

/** Checks for an array whose items all match `guard`. */
export function arrayOf<T>(guard: Guard<T>): Guard<T[]> {
	return (value): value is T[] => Array.isArray(value) && value.every((item) => guard(item));
}

/** Checks that a value is one of the given literals. */
export function oneOf<const T extends readonly (string | number | boolean)[]>(values: T): Guard<T[number]> {
	const set = new Set<unknown>(values);
	return (value): value is T[number] => set.has(value);
}

/** Specification for {@link shape}: one guard per property of `T`, optional ones included. */
export type ShapeSpec<T> = { [K in keyof Required<T>]: Guard<T[K]> };

/**
 * Builds a guard for an object type from one guard per property.
 * Extra properties are allowed so new fields added by the game don't break validation.
 * The spec is checked against `T` at compile time, so a missing property is a type error.
 */
export function shape<T extends object>(spec: ShapeSpec<T>): Guard<T> {
	const entries = Object.entries(spec) as [string, Guard<unknown>][];
	return (value): value is T => {
		if (!isRecord(value)) return false;
		for (const [key, guard] of entries) {
			if (!guard(value[key])) return false;
		}
		return true;
	};
}

/** Combines guards with logical AND. */
export function allOf<T>(guard: Guard<T>, ...checks: ((value: T) => boolean)[]): Guard<T> {
	return (value): value is T => guard(value) && checks.every((check) => check(value));
}
