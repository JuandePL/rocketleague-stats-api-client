import type { EventName, StatsApiEventOf } from '../types/events.js';
import type { MatchMoment, MatchPlayerResult, MatchSummary, TimelineEntry } from './match.js';

/** Time between two moments of a match, measured three ways. */
export interface TimeDifference {
	/** Seconds of play (kickoff countdowns, goal replays and pauses excluded). */
	secondsPlayed: number;
	/** Seconds on the match clock. Regulation time and overtime add up. */
	clockSeconds: number;
	/** Real seconds. Includes pauses, replays and countdowns. */
	realSeconds: number;
}

/** Position on a single timeline: regulation counts down, overtime counts up after it. */
const clockPosition = (moment: MatchMoment) => (moment.overtime ? moment.timeSeconds : -moment.timeSeconds);

/** Time from `from` to `to`. Negative values mean `to` happened first. */
export function timeBetween(from: MatchMoment, to: MatchMoment): TimeDifference {
	return {
		secondsPlayed: to.secondsPlayed - from.secondsPlayed,
		clockSeconds: clockPosition(to) - clockPosition(from),
		realSeconds: (to.date.getTime() - from.date.getTime()) / 1000,
	};
}

/**
 * The first event called `eventName` after `moment` (and matching `filter`, if given).
 *
 * ```ts
 * findEventAfter(summary, player.leftAt!, 'StatfeedEvent', (e) => e.Data.EventName === 'Save');
 * ```
 */
export function findEventAfter<E extends EventName>(
	summary: Pick<MatchSummary, 'timeline'>,
	moment: MatchMoment,
	eventName: E,
	filter?: (event: StatsApiEventOf<E>) => boolean,
): TimelineEntry<E> | undefined {
	const entry = summary.timeline.find(
		(candidate) =>
			candidate.moment.sequence > moment.sequence &&
			candidate.event.Event === eventName &&
			(!filter || filter(candidate.event as StatsApiEventOf<E>)),
	);
	// `Event === eventName` was checked above.
	return entry as TimelineEntry<E> | undefined;
}

/** A player result, or its `key`. */
type PlayerLike = Pick<MatchPlayerResult, 'key'> | string;

function leftAtOf(summary: Pick<MatchSummary, 'playerResults'>, player: PlayerLike): MatchMoment | undefined {
	const key = typeof player === 'string' ? player : player.key;
	return summary.playerResults.find((result) => result.key === key)?.leftAt;
}

/**
 * Time from the moment a player left to the first `eventName` after it (and matching `filter`, if given).
 * `undefined` if the player didn't leave early, or if no such event happened after they left.
 *
 * ```ts
 * timeFromLeftTo(summary, player, 'GoalScored', (e) => e.Data.Scorer.TeamNum !== player.TeamNum); // until conceding
 * timeFromLeftTo(summary, player, 'StatfeedEvent', (e) => e.Data.EventName === 'Demolish');
 * ```
 */
export function timeFromLeftTo<E extends EventName>(
	summary: Pick<MatchSummary, 'playerResults' | 'timeline'>,
	player: PlayerLike,
	eventName: E,
	filter?: (event: StatsApiEventOf<E>) => boolean,
): TimeDifference | undefined {
	const leftAt = leftAtOf(summary, player);
	if (!leftAt) return undefined;
	const entry = findEventAfter(summary, leftAt, eventName, filter);
	return entry ? timeBetween(leftAt, entry.moment) : undefined;
}

/** Time from the moment a player left to the end of the match. `undefined` if they didn't leave early. */
export function timeFromLeftToEnd(summary: Pick<MatchSummary, 'playerResults' | 'endMoment'>, player: PlayerLike): TimeDifference | undefined {
	const leftAt = leftAtOf(summary, player);
	return leftAt ? timeBetween(leftAt, summary.endMoment) : undefined;
}

/**
 * Time from the moment a player left to the next goal, by any team.
 * `undefined` if they didn't leave early, or if no goal was scored after they left.
 */
export function timeFromLeftToNextGoal(
	summary: Pick<MatchSummary, 'playerResults' | 'timeline'>,
	player: PlayerLike,
): TimeDifference | undefined {
	return timeFromLeftTo(summary, player, 'GoalScored');
}
