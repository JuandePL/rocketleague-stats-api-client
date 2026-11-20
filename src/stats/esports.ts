import type { Unsubscribe } from '../client.js';
import type { TeamNum } from '../types/common.js';
import { percentOf, perMinute, teamName, teamSide, TOTAL_STATS } from './helpers.js';
import { MatchTracker, type AbortedMatchSummary, type CrossbarHits, type MatchSummary, type MatchTrackerOptions, type StatsEventSource } from './match.js';

/** How a series ends. */
export type SeriesFormat =
	/** Ends as soon as a team wins more than half of `games` (best of 5 = first to 3). */
	| 'best-of'
	/** Every one of the `games` matches is played. */
	| 'play-all';

export interface SeriesOptions {
	/** Number of matches in the series (e.g. `5` for a best of 5). */
	games: number;
	/** @default 'best-of' */
	format?: SeriesFormat;
	/**
	 * Timeouts each team can call in the series, between the end of a match and the start of the next one.
	 * See {@link EsportsSeries.callTimeout}. `0` turns timeouts off.
	 * @default 0
	 */
	timeouts?: number;
	/**
	 * How long a timeout lasts, in seconds. `0` means it lasts until {@link EsportsSeries.endTimeout} is
	 * called or the next match starts. A timeout always ends when the next match starts (`MatchInitialized`).
	 * @default 0
	 */
	timeoutSeconds?: number;
}

export interface EsportsSeriesOptions extends Partial<SeriesOptions>, MatchTrackerOptions {
	/**
	 * Record without calling {@link EsportsSeries.start}: the series starts right away, and a new one
	 * starts by itself with the same options when a match ends after the previous series finished.
	 * {@link EsportsSeries.stop} turns it off until the next `start()` or `restart()`.
	 * @default true
	 */
	autoStart?: boolean;
	/** @default 5 */
	games?: number;
}

/** `idle`: never started. `running`: recording matches. `finished`: reached its end. `stopped`: ended early with {@link EsportsSeries.stop}. */
export type SeriesStatus = 'idle' | 'running' | 'finished' | 'stopped';

/**
 * Why a timeout ended. `ended`: {@link EsportsSeries.endTimeout}. `expired`: its `timeoutSeconds` ran out.
 * `match-started`: the next match started. `cancelled`: the series was started again, stopped or disposed.
 */
export type SeriesTimeoutEndReason = 'ended' | 'expired' | 'match-started' | 'cancelled';

/** A timeout called by a team between two matches. */
export interface SeriesTimeout {
	/** Name of the team that called it. */
	team: string;
	/** Matches of the series finished when it was called: `1` means between the first and the second match. */
	afterMatch: number;
	startedAt: Date;
	/** When it runs out, with `timeoutSeconds`. `undefined` without a time limit. */
	endsAt: Date | undefined;
	/** `undefined` while it lasts. */
	endedAt: Date | undefined;
	/** `undefined` while it lasts. */
	endReason: SeriesTimeoutEndReason | undefined;
}

/** Why {@link EsportsSeries.callTimeout} refused a timeout. */
export type SeriesTimeoutRefusal =
	/** The series has `timeouts: 0`. */
	| 'disabled'
	/** The series is not running (idle, finished or stopped). */
	| 'not-running'
	/** No match of the series has finished yet: timeouts go between two matches. */
	| 'no-match-played'
	/** A match is being played. */
	| 'match-in-progress'
	/** The team didn't play in the series. */
	| 'unknown-team'
	/** The team used all its timeouts. */
	| 'no-timeouts-left'
	/** Another timeout is running. */
	| 'timeout-active';

/** Thrown by {@link EsportsSeries.callTimeout} when the timeout can't be called. `reason` says why. */
export class SeriesTimeoutError extends Error {
	override readonly name = 'SeriesTimeoutError';
	constructor(
		readonly reason: SeriesTimeoutRefusal,
		readonly team: string,
	) {
		super(`Team "${team}" can't call a timeout: ${reason}.`);
	}
}

/** A team's results over the series. Teams are identified by name, so they can switch sides between matches. */
export interface SeriesTeamResult {
	name: string;
	/** Matches the team played, the one being played included in `getLiveResult()`. */
	matches: number;
	wins: number;
	/** Wins over the finished matches the team played, 0–100. The match being played doesn't count. */
	winPercent: number;
	/** Team score summed over the series, own goals of the other team included. */
	goals: number;
	/** Shots of the team's players over the series. */
	shots: number;
	/** Goals scored by the team's players over their shots, 0–100 (own goals of the other team left out). */
	shootingPercent: number;
	/** Share of possession over the whole series, 0–100. */
	possessionPercent: number;
	boostUsed: number;
	/** `boostUsed` per minute of play over the team's matches. */
	boostPerMinute: number;
	/** Seconds of play over the team's matches. */
	secondsPlayed: number;
	/** Timeouts the team called in the series. */
	timeoutsUsed: number;
	/** Timeouts the team can still call (the `timeouts` option minus `timeoutsUsed`). */
	timeoutsLeft: number;
	/**
	 * Wins added or removed by hand with {@link EsportsSeries.adjustWins}, already counted in `wins`
	 * (but not in `winPercent`, which only looks at the matches played).
	 */
	manualWins: number;
}

/** A player's totals over the series. The results of each match are in `MatchSummary.playerResults`. */
export interface SeriesPlayerResult {
	/** Identifies the player across matches. See {@link playerKey} and the `identifyPlayer` option. */
	key: string;
	/** Platform id in the format `Platform|Uid|Splitscreen` (e.g. `"Steam|123|0"`). Bots have `"Unknown|0|0"`. */
	PrimaryId: string;
	/** `true` for bots. */
	bot: boolean;
	/** Latest name used in the series. */
	Name: string;
	/** Every name the player used in the series, oldest first. */
	names: string[];
	/** Name of the team the player played for in their last match. */
	team: string;
	/** Matches played, including the ones they left before the end. */
	matches: number;
	/** Matches the player left before the end (rage quit, disconnect). Their stats until then are counted. */
	leftEarly: number;
	/** Matches in which the player was the MVP. */
	mvps: number;
	/** Finished matches the player's team won (the team they were on at the end of each match). */
	wins: number;
	/** Wins over the finished matches the player played, 0–100. The match being played doesn't count. */
	winPercent: number;
	/** Seconds of play the player was in, summed over the series (see `MatchPlayerResult.secondsPlayed`). */
	secondsPlayed: number;
	/** Goals of the player's team in each match they played, summed. The base of `goalParticipation`. */
	teamGoals: number;
	/** Times the player entered a match, summed over the series (see `MatchPlayerResult.joins`). */
	joins: number;
	/** Times the player left a match before its end, summed over the series. `leftEarly` counts matches instead. */
	leaves: number;
	Score: number;
	Goals: number;
	Shots: number;
	Assists: number;
	Saves: number;
	Touches: number;
	CarTouches: number;
	Demos: number;
	/** `Goals` / `Shots` over the series, 0–100. `0` without shots. */
	shootingPercent: number;
	/** `Goals` + `Assists` over `teamGoals`, 0–100. `0` when the player's teams didn't score. */
	goalParticipation: number;
	boostUsed: number;
	/** `boostUsed` per minute of `secondsPlayed`. */
	boostPerMinute: number;
	/** Seconds in the air (see `TrackedPlayerStats.airTime`). */
	airTime: number;
	/** Seconds driving on a wall (see `TrackedPlayerStats.onWallTime`). */
	onWallTime: number;
	/** Average speed over the series in km/h, weighted by `drivingTime` (see `TrackedPlayerStats.averageSpeed`). */
	averageSpeed: number;
	/** Seconds the player's speed was measured over the series. */
	drivingTime: number;
	/** Crossbar and post hits on the opponent's goal (`attack`) and on the player's own goal (`defense`). */
	crossbar: CrossbarHits;
}

export interface SeriesResult {
	status: SeriesStatus;
	options: Required<SeriesOptions>;
	/** `true` when the series reached its end (not when it was stopped early). */
	finished: boolean;
	/** Every recorded match, in order. Each one has its own `playerResults`. */
	matches: MatchSummary[];
	/**
	 * Matches of the series left before their end (`MatchDestroyed` without `MatchEnded`), in order, with the
	 * stats until then. They don't count for anything else in the result: not for wins, totals, nor the series end.
	 */
	abortedMatches: AbortedMatchSummary[];
	/** Teams sorted by wins, then goals. */
	teams: SeriesTeamResult[];
	/** Team with the most wins once the series is over. `undefined` while running, or on a tie. */
	winner: string | undefined;
	/** Players sorted by total score. */
	players: SeriesPlayerResult[];
	/** Highest total score on the winning team (or overall if there is no winner yet). */
	mvp: SeriesPlayerResult | undefined;
	/** Every timeout called in the series, in order, the running one included. */
	timeouts: SeriesTimeout[];
	/** The timeout running right now, if any. */
	activeTimeout: SeriesTimeout | undefined;
	/** Wins added or removed by hand with {@link EsportsSeries.adjustWins}, by team name. Already counted in `teams`. */
	manualWins: Record<string, number>;
}

/**
 * Everything an {@link EsportsSeries} stores, to save it and bring it back later with {@link EsportsSeries.restore},
 * for example after a restart. It can go through `JSON.stringify` / `JSON.parse`: dates become strings and
 * `restore()` turns them back into dates. The match being played is not included.
 */
export interface SeriesSnapshot {
	version: 1;
	status: SeriesStatus;
	options: Required<SeriesOptions>;
	/** `true` after {@link EsportsSeries.stop}: no automatic restart. */
	stoppedByUser: boolean;
	matches: MatchSummary[];
	abortedMatches: AbortedMatchSummary[];
	timeouts: SeriesTimeout[];
	/** Index in `timeouts` of the running timeout, if any. */
	activeTimeout: number | undefined;
	manualWins: Record<string, number>;
}

/** What the series totals need from a match. A match in progress has no `winnerTeamNum` yet. */
type CountedMatch = Pick<MatchSummary, 'teams' | 'boost' | 'possession' | 'playerResults' | 'secondsPlayed'> & {
	winnerTeamNum?: TeamNum;
	/** Holds the team names given when the match was played (see the `identifyTeam` option). */
	teamResults?: readonly { TeamNum: TeamNum; name: string }[];
};

/** Name of the team on `teamNum` in a match: the name stored in its results, so it doesn't change afterwards. */
function nameIn(match: CountedMatch, teamNum: TeamNum): string {
	return match.teamResults?.find((team) => team.TeamNum === teamNum)?.name || teamName(match.teams, teamNum);
}

/** Keys that hold dates in a series, turned back from strings by `restore()`. */
const DATE_KEYS = new Set(['date', 'endedAt', 'startedAt', 'endsAt']);

/** Deep copy that turns the ISO strings of {@link DATE_KEYS} back into dates. */
function reviveDates<T>(value: T, key = ''): T {
	if (Array.isArray(value)) return value.map((item) => reviveDates(item)) as T;
	if (value instanceof Date) return new Date(value.getTime()) as T;
	if (typeof value === 'string' && DATE_KEYS.has(key)) {
		const date = new Date(value);
		return (Number.isNaN(date.getTime()) ? value : date) as T;
	}
	if (value && typeof value === 'object') {
		const copy: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) copy[k] = reviveDates(v, k);
		return copy as T;
	}
	return value;
}

export type SeriesStartListener = (options: Required<SeriesOptions>) => void;
export type SeriesMatchListener = (match: MatchSummary, series: SeriesResult) => void;
export type SeriesMatchAbortListener = (match: AbortedMatchSummary, series: SeriesResult) => void;
export type SeriesEndListener = (series: SeriesResult) => void;
export type SeriesTimeoutListener = (timeout: SeriesTimeout, series: SeriesResult) => void;
export type SeriesUpdateListener = (series: SeriesResult) => void;

function normalizeOptions(options: Partial<SeriesOptions>): Required<SeriesOptions> {
	const games = options.games ?? 5;
	if (!Number.isInteger(games) || games < 1) throw new RangeError(`games must be a positive integer, got ${games}.`);
	const timeouts = options.timeouts ?? 0;
	if (!Number.isInteger(timeouts) || timeouts < 0) throw new RangeError(`timeouts must be a non-negative integer, got ${timeouts}.`);
	const timeoutSeconds = options.timeoutSeconds ?? 0;
	if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
		throw new RangeError(`timeoutSeconds must be a non-negative number, got ${timeoutSeconds}.`);
	}
	return { games, format: options.format ?? 'best-of', timeouts, timeoutSeconds };
}

const copyTimeout = (timeout: SeriesTimeout): SeriesTimeout => ({ ...timeout });

/**
 * Esports mode: records a series of matches in memory and gives you the results.
 *
 * ```ts
 * const series = new EsportsSeries(client, { games: 5 }); // best of 5, starts recording right away
 * series.onMatchEnd((match, result) => console.log(`Game ${result.matches.length}: ${match.mvp?.Name} MVP`));
 * series.onSeriesEnd((result) => console.log(`${result.winner} wins the series`));
 * ```
 *
 * Only matches that end (`MatchEnded`) while the series is running are recorded.
 * Every {@link start} or {@link restart} clears the stored matches.
 *
 * With the `timeouts` option, each team can call timeouts between matches with {@link callTimeout}.
 */
export class EsportsSeries {
	/** Live stats of the match being played. */
	readonly tracker: MatchTracker;

	#status: SeriesStatus = 'idle';
	#autoStart: boolean;
	/** Set by `stop()` so `autoStart` doesn't start a new series behind the user's back. */
	#stoppedByUser = false;
	#options: Required<SeriesOptions>;
	#matches: MatchSummary[] = [];
	#abortedMatches: AbortedMatchSummary[] = [];
	readonly #startListeners = new Set<SeriesStartListener>();
	readonly #matchListeners = new Set<SeriesMatchListener>();
	readonly #abortListeners = new Set<SeriesMatchAbortListener>();
	readonly #endListeners = new Set<SeriesEndListener>();
	readonly #timeoutStartListeners = new Set<SeriesTimeoutListener>();
	readonly #timeoutEndListeners = new Set<SeriesTimeoutListener>();
	readonly #updateListeners = new Set<SeriesUpdateListener>();
	#timeouts: SeriesTimeout[] = [];
	#manualWins = new Map<string, number>();
	#activeTimeout: SeriesTimeout | undefined;
	#timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	readonly #unsubscribe: Unsubscribe;
	readonly #unsubscribeStart: Unsubscribe;
	readonly #unsubscribeAbort: Unsubscribe;

	constructor(source?: StatsEventSource, options: EsportsSeriesOptions = {}) {
		this.#options = normalizeOptions(options);
		this.#autoStart = options.autoStart ?? true;
		this.tracker = new MatchTracker(source, { identifyPlayer: options.identifyPlayer, identifyTeam: options.identifyTeam });
		this.#unsubscribe = this.tracker.onMatchEnd((summary) => this.#record(summary));
		this.#unsubscribeStart = this.tracker.onMatchStart(() => this.#finishTimeout('match-started'));
		this.#unsubscribeAbort = this.tracker.onMatchAbort((summary) => this.#recordAbort(summary));
		if (this.#autoStart) this.start(this.#options);
	}

	get status(): SeriesStatus {
		return this.#status;
	}

	/** `true` when series start and restart by themselves. After {@link stop}, nothing restarts until `start()` or `restart()`. */
	get autoStart(): boolean {
		return this.#autoStart;
	}

	/** Recorded matches, in order. */
	get matches(): readonly MatchSummary[] {
		return this.#matches;
	}

	/** Matches of the series left before their end, in order. They don't count in the results. */
	get abortedMatches(): readonly AbortedMatchSummary[] {
		return this.#abortedMatches;
	}

	/** Starts a new series. Clears any stored matches, even if a series was running. */
	start(options: SeriesOptions = this.#options): void {
		const normalized = normalizeOptions(options);
		this.#finishTimeout('cancelled');
		this.#options = normalized;
		this.#matches = [];
		this.#abortedMatches = [];
		this.#timeouts = [];
		this.#manualWins = new Map();
		this.#status = 'running';
		this.#stoppedByUser = false;
		for (const listener of [...this.#startListeners]) listener({ ...this.#options });
		this.#emitUpdate();
	}

	/** Starts the series again with the same options. Clears the stored matches. */
	restart(): void {
		this.start(this.#options);
	}

	/** Stops recording, including the automatic restart. The matches played so far stay in {@link getResult}. */
	stop(): void {
		this.#finishTimeout('cancelled');
		if (this.#status === 'running') this.#status = 'stopped';
		this.#stoppedByUser = true;
		this.#emitUpdate();
	}

	/** Stops listening to the client. A running timeout is cancelled. */
	dispose(): void {
		this.#finishTimeout('cancelled');
		this.#unsubscribe();
		this.#unsubscribeStart();
		this.#unsubscribeAbort();
		this.tracker.detach();
	}

	/** The timeout running right now, if any. */
	get activeTimeout(): SeriesTimeout | undefined {
		return this.#activeTimeout && copyTimeout(this.#activeTimeout);
	}

	/**
	 * Name of a team given by name or by `TeamNum`. A `TeamNum` is the side the team played on in the last
	 * finished match of the series (teams can switch sides between matches).
	 */
	teamOf(team: string | TeamNum): string {
		if (typeof team === 'string') return team;
		const last = this.#matches.at(-1);
		// Before the first match ends, the side the team plays on right now.
		return last ? nameIn(last, team) : this.tracker.teamNameOf(team);
	}

	/** Timeouts `team` (name or `TeamNum`, see {@link teamOf}) can still call in this series. `0` for a team that didn't play in it. */
	timeoutsLeft(teamOrNum: string | TeamNum): number {
		const team = this.teamOf(teamOrNum);
		return this.#teamNames().has(team) ? this.#timeoutsLeftOf(team) : 0;
	}

	/**
	 * `true` if `team` (name or `TeamNum`, see {@link teamOf}) still has timeouts to call in this series.
	 * It doesn't check whether one can be called right now (for that, see {@link canCallTimeout}).
	 */
	hasTimeoutsLeft(team: string | TeamNum): boolean {
		return this.timeoutsLeft(team) > 0;
	}

	/** Why `team` (name or `TeamNum`, see {@link teamOf}) can't call a timeout right now, or `undefined` if it can. */
	timeoutRefusal(team: string | TeamNum): SeriesTimeoutRefusal | undefined {
		return this.#refusal(this.teamOf(team));
	}

	/** {@link timeoutRefusal} for a team name. */
	#refusal(team: string): SeriesTimeoutRefusal | undefined {
		if (this.#options.timeouts === 0) return 'disabled';
		if (this.#status !== 'running') return 'not-running';
		if (this.#matches.length === 0) return 'no-match-played';
		if (this.tracker.matchStarted) return 'match-in-progress';
		if (!this.#teamNames().has(team)) return 'unknown-team';
		if (this.#timeoutsLeftOf(team) === 0) return 'no-timeouts-left';
		if (this.#activeTimeout) return 'timeout-active';
		return undefined;
	}

	/** `true` if `team` can call a timeout right now. See {@link timeoutRefusal} for why not. */
	canCallTimeout(team: string | TeamNum): boolean {
		return this.timeoutRefusal(team) === undefined;
	}

	/**
	 * `team` calls a timeout: its name (as in `SeriesTeamResult.name`) or its `TeamNum` in the last finished match
	 * (see {@link teamOf}). Only between the end of a match of the series and the start of the next one, while the
	 * team has timeouts left and no other timeout is running.
	 *
	 * The timeout ends with {@link endTimeout}, when `timeoutSeconds` run out, or when the next match starts.
	 * @throws {SeriesTimeoutError} when the timeout can't be called; its `reason` says why.
	 */
	callTimeout(teamOrNum: string | TeamNum): SeriesTimeout {
		const team = this.teamOf(teamOrNum);
		const refusal = this.#refusal(team);
		if (refusal) throw new SeriesTimeoutError(refusal, team);
		const startedAt = new Date();
		const { timeoutSeconds } = this.#options;
		const timeout: SeriesTimeout = {
			team,
			afterMatch: this.#matches.length,
			startedAt,
			endsAt: timeoutSeconds > 0 ? new Date(startedAt.getTime() + timeoutSeconds * 1000) : undefined,
			endedAt: undefined,
			endReason: undefined,
		};
		this.#timeouts.push(timeout);
		this.#activeTimeout = timeout;
		this.#armTimeoutTimer(timeout);
		const result = this.getResult();
		for (const listener of [...this.#timeoutStartListeners]) listener(copyTimeout(timeout), result);
		this.#emitUpdate(result);
		return copyTimeout(timeout);
	}

	/** Ends the running timeout early (for example when the team is ready). Returns it, or `undefined` if none was running. */
	endTimeout(): SeriesTimeout | undefined {
		return this.#finishTimeout('ended');
	}

	/** Called when a team calls a timeout. Returns a function that removes the listener. */
	onTimeoutStart(listener: SeriesTimeoutListener): Unsubscribe {
		this.#timeoutStartListeners.add(listener);
		return () => this.#timeoutStartListeners.delete(listener);
	}

	/** Called when a timeout ends, whatever the reason (see `endReason`). Returns a function that removes the listener. */
	onTimeoutEnd(listener: SeriesTimeoutListener): Unsubscribe {
		this.#timeoutEndListeners.add(listener);
		return () => this.#timeoutEndListeners.delete(listener);
	}

	#finishTimeout(reason: SeriesTimeoutEndReason, endedAt = new Date()): SeriesTimeout | undefined {
		const timeout = this.#activeTimeout;
		if (!timeout) return undefined;
		this.#clearTimeoutTimer();
		this.#activeTimeout = undefined;
		timeout.endedAt = endedAt;
		timeout.endReason = reason;
		const result = this.getResult();
		for (const listener of [...this.#timeoutEndListeners]) listener(copyTimeout(timeout), result);
		this.#emitUpdate(result);
		return copyTimeout(timeout);
	}

	#clearTimeoutTimer(): void {
		clearTimeout(this.#timeoutTimer);
		this.#timeoutTimer = undefined;
	}

	/** Ends the running timeout when its `endsAt` comes. */
	#armTimeoutTimer(timeout: SeriesTimeout): void {
		this.#clearTimeoutTimer();
		if (!timeout.endsAt) return;
		const delay = Math.max(0, timeout.endsAt.getTime() - Date.now());
		this.#timeoutTimer = setTimeout(() => this.#finishTimeout('expired'), delay);
		// Don't keep a Node process alive only for the timer.
		(this.#timeoutTimer as { unref?: () => void }).unref?.();
	}

	/** Teams that played a finished match of the series. */
	#teamNames(): Set<string> {
		const names = new Set<string>();
		for (const match of this.#matches) for (const teamNum of [0, 1]) names.add(nameIn(match, teamNum));
		return names;
	}

	#timeoutsUsed(team: string, timeouts: readonly SeriesTimeout[] = this.#timeouts): number {
		return timeouts.filter((timeout) => timeout.team === team).length;
	}

	/** Never negative: `callTimeout` stops at the limit, and `start()` changes the limit and clears the timeouts together. */
	#timeoutsLeftOf(team: string, timeouts: readonly SeriesTimeout[] = this.#timeouts): number {
		return this.#options.timeouts - this.#timeoutsUsed(team, timeouts);
	}

	/** Called every time a series starts, including automatic restarts. Returns a function that removes the listener. */
	onSeriesStart(listener: SeriesStartListener): Unsubscribe {
		this.#startListeners.add(listener);
		return () => this.#startListeners.delete(listener);
	}

	/** Called after each recorded match. Returns a function that removes the listener. */
	onMatchEnd(listener: SeriesMatchListener): Unsubscribe {
		this.#matchListeners.add(listener);
		return () => this.#matchListeners.delete(listener);
	}

	/**
	 * Called when a match of the running series is left before its end (`MatchDestroyed` without `MatchEnded`),
	 * with the stats until then. It is kept in `abortedMatches` and doesn't count in the results.
	 * Returns a function that removes the listener.
	 */
	onMatchAbort(listener: SeriesMatchAbortListener): Unsubscribe {
		this.#abortListeners.add(listener);
		return () => this.#abortListeners.delete(listener);
	}

	#recordAbort(summary: AbortedMatchSummary): void {
		// A match left after a finished series would have been the first of the next one: nothing to keep.
		if (this.#status !== 'running') return;
		this.#abortedMatches.push(summary);
		const result = this.getResult();
		for (const listener of [...this.#abortListeners]) listener(summary, result);
		this.#emitUpdate(result);
	}

	/** Called once when the series reaches its end. Returns a function that removes the listener. */
	onSeriesEnd(listener: SeriesEndListener): Unsubscribe {
		this.#endListeners.add(listener);
		return () => this.#endListeners.delete(listener);
	}

	#record(summary: MatchSummary): void {
		// The previous series is kept until the next match ends, so its result can still be read.
		if (this.#status === 'finished' && this.#autoStart && !this.#stoppedByUser) this.start(this.#options);
		if (this.#status !== 'running') return;
		this.#matches.push(summary);
		if (this.#isOver()) this.#status = 'finished';

		const result = this.getResult();
		for (const listener of [...this.#matchListeners]) listener(summary, result);
		if (this.#status === 'finished') for (const listener of [...this.#endListeners]) listener(result);
		this.#emitUpdate(result);
	}

	#isOver(): boolean {
		const { games, format } = this.#options;
		// Wins added by hand stand for matches played somewhere else (a forfeit, a crash...).
		let added = 0;
		for (const team of this.#teams(this.#matches)) added += Math.max(0, team.manualWins);
		if (this.#matches.length + added >= games) return true;
		if (format !== 'best-of') return false;
		const needed = Math.floor(games / 2) + 1;
		return this.#teams(this.#matches).some((team) => team.wins >= needed);
	}

	/** After the stored matches or wins change by hand: the series can end, or go on again. */
	#updateStatus(): void {
		if (this.#status === 'running' && this.#isOver()) {
			this.#status = 'finished';
			this.#finishTimeout('cancelled');
			const result = this.getResult();
			for (const listener of [...this.#endListeners]) listener(result);
		} else if (this.#status === 'finished' && !this.#isOver()) {
			this.#status = 'running';
		}
	}

	/**
	 * Adds wins to a team by hand (or removes them with a negative `delta`), for example for a match played
	 * outside the game's view, a forfeit, or to fix the score. `team` is a name or a `TeamNum` (see
	 * {@link teamOf}). A team's wins never go below `0`. The series can end, or go on again, with the change:
	 * `onSeriesEnd` is called if it ends. Only while the series is `running` or `finished`.
	 * Cleared by {@link start} and {@link restart}. Returns the team's wins after the change.
	 */
	adjustWins(teamOrNum: string | TeamNum, delta: number): number {
		if (!Number.isInteger(delta)) throw new RangeError(`delta must be an integer, got ${delta}.`);
		const team = this.teamOf(teamOrNum);
		if (this.#status !== 'running' && this.#status !== 'finished') return this.#winsOf(team);
		const manual = this.#manualWins.get(team) ?? 0;
		const played = this.#winsOf(team) - manual;
		const next = Math.max(-played, manual + delta);
		if (next === manual) return this.#winsOf(team);
		if (next === 0) this.#manualWins.delete(team);
		else this.#manualWins.set(team, next);
		this.#updateStatus();
		this.#emitUpdate();
		return this.#winsOf(team);
	}

	/** Sets the wins of a team by hand. Same as {@link adjustWins} with the difference. */
	setWins(teamOrNum: string | TeamNum, wins: number): number {
		const team = this.teamOf(teamOrNum);
		return this.adjustWins(team, Math.max(0, Math.round(wins)) - this.#winsOf(team));
	}

	/** Wins of a team in the series (name or `TeamNum`, see {@link teamOf}), manual ones included. */
	winsOf(team: string | TeamNum): number {
		return this.#winsOf(this.teamOf(team));
	}

	#winsOf(team: string): number {
		return this.#teams(this.#matches).find((entry) => entry.name === team)?.wins ?? 0;
	}

	/**
	 * Removes the last recorded match, for example one that shouldn't count. A finished series goes on again
	 * if it isn't over without it. Returns the removed match, or `undefined` when there was none.
	 */
	removeLastMatch(): MatchSummary | undefined {
		const removed = this.#matches.pop();
		if (!removed) return undefined;
		this.#updateStatus();
		this.#emitUpdate();
		return removed;
	}

	/**
	 * Called after anything stored changes: a series starts or stops, a match is recorded, aborted or removed,
	 * wins are adjusted, a timeout starts or ends, or a snapshot is restored. Handy to save a {@link snapshot}.
	 * Not called on every `UpdateState`: use {@link getLiveResult} for live totals.
	 * Returns a function that removes the listener.
	 */
	onUpdate(listener: SeriesUpdateListener): Unsubscribe {
		this.#updateListeners.add(listener);
		return () => this.#updateListeners.delete(listener);
	}

	#emitUpdate(result?: SeriesResult): void {
		if (this.#updateListeners.size === 0) return;
		const current = result ?? this.getResult();
		for (const listener of [...this.#updateListeners]) listener(current);
	}

	/** Everything the series stores, to bring it back with {@link restore}. Safe to `JSON.stringify`. */
	snapshot(): SeriesSnapshot {
		const index = this.#activeTimeout ? this.#timeouts.indexOf(this.#activeTimeout) : -1;
		const snapshot: SeriesSnapshot = {
			version: 1,
			status: this.#status,
			options: { ...this.#options },
			stoppedByUser: this.#stoppedByUser,
			matches: this.#matches,
			abortedMatches: this.#abortedMatches,
			timeouts: this.#timeouts,
			activeTimeout: index >= 0 ? index : undefined,
			manualWins: Object.fromEntries(this.#manualWins),
		};
		return reviveDates(snapshot);
	}

	/**
	 * Brings back a series saved with {@link snapshot}, also after `JSON.parse` (dates are turned back into
	 * dates). Replaces everything stored, without calling `onSeriesStart`. A running timeout goes on until its
	 * `endsAt`, or ends right away (`'expired'`) if that time already passed. The match being played, if any,
	 * keeps being tracked and is recorded when it ends. Calls {@link onUpdate}.
	 * @throws {TypeError} when `snapshot` is not a series snapshot.
	 */
	restore(snapshot: SeriesSnapshot): void {
		if (!snapshot || typeof snapshot !== 'object' || snapshot.version !== 1 || !Array.isArray(snapshot.matches)) {
			throw new TypeError('Not a series snapshot (version 1).');
		}
		const data = reviveDates(snapshot);
		this.#clearTimeoutTimer();
		this.#options = normalizeOptions(data.options ?? {});
		this.#status = (['idle', 'running', 'finished', 'stopped'] as const).includes(data.status) ? data.status : 'running';
		this.#stoppedByUser = data.stoppedByUser === true;
		this.#matches = [...data.matches];
		this.#abortedMatches = [...(data.abortedMatches ?? [])];
		this.#timeouts = [...(data.timeouts ?? [])];
		this.#manualWins = new Map(
			Object.entries(data.manualWins ?? {}).filter((entry): entry is [string, number] => Number.isInteger(entry[1]) && entry[1] !== 0),
		);
		const active = data.activeTimeout === undefined || data.activeTimeout === null ? undefined : this.#timeouts[data.activeTimeout];
		this.#activeTimeout = active && !active.endedAt ? active : undefined;
		if (this.#activeTimeout?.endsAt && this.#activeTimeout.endsAt.getTime() <= Date.now()) {
			this.#finishTimeout('expired', this.#activeTimeout.endsAt);
			return;
		}
		if (this.#activeTimeout) this.#armTimeoutTimer(this.#activeTimeout);
		this.#emitUpdate();
	}

	#teams(
		matches: readonly CountedMatch[],
		timeouts: readonly SeriesTimeout[] = this.#timeouts,
		manualWins: ReadonlyMap<string, number> = this.#manualWins,
	): SeriesTeamResult[] {
		interface TeamEntry {
			result: SeriesTeamResult;
			possession: number;
			/** Finished matches: the base of `winPercent`. */
			decided: number;
			/** Goals of the team's players (no own goals of the other team): the base of `shootingPercent`. */
			playerGoals: number;
		}
		const teams = new Map<string, TeamEntry>();
		let possessionTotal = 0;
		const get = (name: string) => {
			let entry = teams.get(name);
			if (!entry) {
				entry = {
					result: {
						name,
						matches: 0,
						wins: 0,
						winPercent: 0,
						goals: 0,
						shots: 0,
						shootingPercent: 0,
						possessionPercent: 0,
						boostUsed: 0,
						boostPerMinute: 0,
						secondsPlayed: 0,
						timeoutsUsed: 0,
						timeoutsLeft: 0,
						manualWins: 0,
					},
					possession: 0,
					decided: 0,
					playerGoals: 0,
				};
				teams.set(name, entry);
			}
			return entry;
		};

		for (const match of matches) {
			for (const teamNum of [0, 1]) {
				const side = teamSide(teamNum)!;
				const entry = get(nameIn(match, teamNum));
				entry.result.matches++;
				if (match.winnerTeamNum !== undefined) entry.decided++;
				entry.result.goals += match.teams.find((team) => team.TeamNum === teamNum)?.Score ?? 0;
				for (const player of match.playerResults) {
					if (player.TeamNum !== teamNum) continue;
					entry.result.shots += player.Shots;
					entry.playerGoals += player.Goals;
				}
				entry.result.boostUsed += match.boost.teams[side];
				entry.result.secondsPlayed += match.secondsPlayed;
				entry.possession += match.possession.seconds[side];
			}
			if (match.winnerTeamNum !== undefined) get(nameIn(match, match.winnerTeamNum)).result.wins++;
			possessionTotal += match.possession.seconds.blue + match.possession.seconds.orange;
		}
		for (const [name, wins] of manualWins) {
			const { result } = get(name);
			// Never below 0, whatever was removed by hand.
			result.manualWins = Math.max(wins, -result.wins);
			result.wins += result.manualWins;
		}

		return [...teams.values()]
			.map(({ result, possession, decided, playerGoals }) => ({
				...result,
				winPercent: percentOf(result.wins - result.manualWins, decided),
				shootingPercent: percentOf(playerGoals, result.shots),
				boostPerMinute: perMinute(result.boostUsed, result.secondsPlayed),
				possessionPercent: percentOf(possession, possessionTotal),
				timeoutsUsed: this.#timeoutsUsed(result.name, timeouts),
				timeoutsLeft: this.#timeoutsLeftOf(result.name, timeouts),
			}))
			.sort((a, b) => b.wins - a.wins || b.goals - a.goals);
	}

	#players(matches: readonly CountedMatch[]): SeriesPlayerResult[] {
		const players = new Map<string, SeriesPlayerResult>();
		/** Finished matches of each player: the base of `winPercent`. */
		const decided = new Map<string, number>();
		for (const match of matches) {
			for (const result of match.playerResults) {
				let total = players.get(result.key);
				if (!total) {
					total = {
						key: result.key,
						PrimaryId: result.PrimaryId,
						bot: result.bot,
						Name: result.Name,
						names: [],
						team: result.team,
						matches: 0,
						leftEarly: 0,
						mvps: 0,
						wins: 0,
						winPercent: 0,
						secondsPlayed: 0,
						teamGoals: 0,
						shootingPercent: 0,
						goalParticipation: 0,
						boostPerMinute: 0,
						joins: 0,
						leaves: 0,
						Score: 0,
						Goals: 0,
						Shots: 0,
						Assists: 0,
						Saves: 0,
						Touches: 0,
						CarTouches: 0,
						Demos: 0,
						boostUsed: 0,
						airTime: 0,
						onWallTime: 0,
						averageSpeed: 0,
						drivingTime: 0,
						crossbar: { attack: 0, defense: 0, total: 0 },
					};
					players.set(result.key, total);
				}
				total.team = result.team;
				total.Name = result.Name;
				if (!total.names.includes(result.Name)) total.names.push(result.Name);
				total.matches++;
				if (result.leftEarly) total.leftEarly++;
				if (result.mvp) total.mvps++;
				if (result.won !== undefined) decided.set(result.key, (decided.get(result.key) ?? 0) + 1);
				if (result.won) total.wins++;
				total.secondsPlayed += result.secondsPlayed;
				total.teamGoals += match.teams.find((team) => team.TeamNum === result.TeamNum)?.Score ?? 0;
				total.joins += result.joins;
				total.leaves += result.leaves;
				if (result.PrimaryId) total.PrimaryId = result.PrimaryId;
				for (const stat of TOTAL_STATS) total[stat] += result[stat];
				total.boostUsed += result.boostUsed;
				total.airTime += result.airTime;
				total.onWallTime += result.onWallTime;
				const drivingTime = total.drivingTime + result.drivingTime;
				if (drivingTime > 0) {
					total.averageSpeed = (total.averageSpeed * total.drivingTime + result.averageSpeed * result.drivingTime) / drivingTime;
				}
				total.drivingTime = drivingTime;
				total.crossbar.attack += result.crossbar.attack;
				total.crossbar.defense += result.crossbar.defense;
				total.crossbar.total += result.crossbar.total;
			}
		}
		for (const total of players.values()) {
			total.winPercent = percentOf(total.wins, decided.get(total.key) ?? 0);
			total.shootingPercent = percentOf(total.Goals, total.Shots);
			total.goalParticipation = percentOf(total.Goals + total.Assists, total.teamGoals);
			total.boostPerMinute = perMinute(total.boostUsed, total.secondsPlayed);
		}
		return [...players.values()].sort((a, b) => b.Score - a.Score);
	}

	/** Results so far. Can be called at any time; check `finished` to know if the series is over. */
	getResult(): SeriesResult {
		return this.#result(this.#matches);
	}

	/**
	 * Like {@link getResult}, but the team and player totals also include the match being played, so they
	 * update live. Cheap enough to call on every `UpdateState`.
	 *
	 * - The current match adds goals, boost, possession and player stats, but no win until it ends.
	 * - `matches` still holds only the finished matches. The current match is in `tracker`.
	 * - After a series finished with `autoStart`, a match being played is the first of the next series: the
	 *   live result is then that new series (`status: 'running'`, no finished matches yet), while `getResult()`
	 *   keeps the finished one until that match ends.
	 * - With no match being played (the lobby before `MatchInitialized` included, see `tracker.matchStarted`), or when
	 *   the series is `idle` or `stopped`, it is the same as `getResult()`.
	 */
	getLiveResult(): SeriesResult {
		// Not matchInProgress: that one is already true in the lobby, which would count an empty match.
		if (!this.tracker.matchStarted) return this.getResult();
		const current: CountedMatch = {
			...this.tracker.getStats(),
			teams: this.tracker.getTeams(),
			teamResults: this.tracker.getTeamResults(),
			playerResults: this.tracker.getPlayerResults(),
		};
		if (this.#status === 'running') return this.#result(this.#matches, [...this.#matches, current]);
		if (this.#status === 'finished' && this.#autoStart && !this.#stoppedByUser) return this.#result([], [current], 'running', true);
		return this.getResult();
	}

	#result(
		matches: MatchSummary[],
		counted: readonly CountedMatch[] = matches,
		status: SeriesStatus = this.#status,
		/** The live result of the next series during its first match: the timeouts and aborted matches stored belong to the previous one. */
		nextSeries = false,
	): SeriesResult {
		const timeouts = nextSeries ? [] : this.#timeouts;
		const teams = this.#teams(counted, timeouts, nextSeries ? new Map() : this.#manualWins);
		const active = nextSeries ? undefined : this.#activeTimeout;
		const players = this.#players(counted);
		const over = status === 'finished' || status === 'stopped';
		const [first, second] = teams;
		const winner = over && first && (!second || first.wins > second.wins) ? first.name : undefined;
		const mvp = (winner ? players.find((player) => player.team === winner) : undefined) ?? players[0];
		return {
			status,
			options: { ...this.#options },
			finished: status === 'finished',
			matches: [...matches],
			abortedMatches: nextSeries ? [] : [...this.#abortedMatches],
			teams,
			winner,
			players,
			mvp,
			timeouts: timeouts.map(copyTimeout),
			activeTimeout: active && copyTimeout(active),
			manualWins: nextSeries ? {} : Object.fromEntries(this.#manualWins),
		};
	}
}
