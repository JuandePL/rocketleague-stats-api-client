import type { Player, PlayerRef } from './types/common.js';

/** Compares two players like an `Array.prototype.sort` callback. */
export type PlayerComparator<T extends PlayerRef = Player> = (a: T, b: T) => number;

/** Sort direction. */
export type SortOrder = 'asc' | 'desc';

/** Numeric `Player` fields that can be used with {@link byStat}. */
export type PlayerStat = {
	[K in keyof Player]-?: NonNullable<Player[K]> extends number ? K : never;
}[keyof Player];

const direction = (order: SortOrder) => (order === 'asc' ? 1 : -1);

/** Orders by team: Blue (0) first, or Orange (1) first with `'desc'`. */
export function byTeam<T extends PlayerRef>(order: SortOrder = 'asc'): PlayerComparator<T> {
	return (a, b) => (a.TeamNum - b.TeamNum) * direction(order);
}

/** Orders by spectator shortcut. */
export function byShortcut<T extends PlayerRef>(order: SortOrder = 'asc'): PlayerComparator<T> {
	return (a, b) => (a.Shortcut - b.Shortcut) * direction(order);
}

/** Orders by display name (case-insensitive, locale-aware). */
export function byName<T extends PlayerRef>(order: SortOrder = 'asc'): PlayerComparator<T> {
	return (a, b) => a.Name.localeCompare(b.Name, undefined, { sensitivity: 'base' }) * direction(order);
}

/** Orders by a numeric stat (`Score`, `Goals`, `Boost`…). Highest first by default. Missing values go last. */
export function byStat(stat: PlayerStat, order: SortOrder = 'desc'): PlayerComparator {
	return (a, b) => {
		const x = a[stat];
		const y = b[stat];
		if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? 1 : -1;
		return (x - y) * direction(order);
	};
}

/**
 * Returns a new array sorted by the given comparators: the first one decides, the next ones break ties.
 * The sort is stable, so players that compare equal keep their original order. The input is not modified.
 *
 * ```ts
 * sortPlayers(data.Players, byTeam(), byStat('Score'));        // Blue then Orange, best score first
 * sortPlayers(data.Players, (a, b) => a.Demos - b.Demos);       // any custom comparator
 * ```
 */
export function sortPlayers<T extends PlayerRef>(players: readonly T[], ...comparators: PlayerComparator<T>[]): T[] {
	const copy = [...players];
	if (comparators.length === 0) return copy;
	return copy.sort((a, b) => {
		for (const compare of comparators) {
			const result = compare(a, b);
			if (result !== 0) return result;
		}
		return 0;
	});
}
