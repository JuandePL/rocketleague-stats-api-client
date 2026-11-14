import type { Unsubscribe } from '../client.js';
import { teamName, teamSide, TOTAL_STATS } from './helpers.js';
import { MatchTracker, type CrossbarHits, type MatchSummary, type StatsEventSource } from './match.js';

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
}

export interface EsportsSeriesOptions extends Partial<SeriesOptions> {
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

/** A team's results over the series. Teams are identified by name, so they can switch sides between matches. */
export interface SeriesTeamResult {
	name: string;
	wins: number;
	goals: number;
	/** Share of possession over the whole series, 0–100. */
	possessionPercent: number;
	/** Share of time the ball was in the opponent's half over the whole series, 0–100. */
	pressurePercent: number;
	boostUsed: number;
}

/** A player's totals over the series. The results of each match are in `MatchSummary.playerResults`. */
export interface SeriesPlayerResult {
	/** See {@link playerKey}. */
	key: string;
	Name: string;
	/** Name of the team the player played for in their last match. */
	team: string;
	matches: number;
	/** Matches in which the player was the MVP. */
	mvps: number;
	Score: number;
	Goals: number;
	Shots: number;
	Assists: number;
	Saves: number;
	Touches: number;
	CarTouches: number;
	Demos: number;
	boostUsed: number;
	/** Seconds in the air (see `TrackedPlayerStats.airTime`). */
	airTime: number;
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
	/** Teams sorted by wins, then goals. */
	teams: SeriesTeamResult[];
	/** Team with the most wins once the series is over. `undefined` while running, or on a tie. */
	winner: string | undefined;
	/** Players sorted by total score. */
	players: SeriesPlayerResult[];
	/** Highest total score on the winning team (or overall if there is no winner yet). */
	mvp: SeriesPlayerResult | undefined;
}

export type SeriesStartListener = (options: Required<SeriesOptions>) => void;
export type SeriesMatchListener = (match: MatchSummary, series: SeriesResult) => void;
export type SeriesEndListener = (series: SeriesResult) => void;

function normalizeOptions(options: Partial<SeriesOptions>): Required<SeriesOptions> {
	const games = options.games ?? 5;
	if (!Number.isInteger(games) || games < 1) throw new RangeError(`games must be a positive integer, got ${games}.`);
	return { games, format: options.format ?? 'best-of' };
}

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
	readonly #startListeners = new Set<SeriesStartListener>();
	readonly #matchListeners = new Set<SeriesMatchListener>();
	readonly #endListeners = new Set<SeriesEndListener>();
	readonly #unsubscribe: Unsubscribe;

	constructor(source?: StatsEventSource, options: EsportsSeriesOptions = {}) {
		this.#options = normalizeOptions(options);
		this.#autoStart = options.autoStart ?? true;
		this.tracker = new MatchTracker(source);
		this.#unsubscribe = this.tracker.onMatchEnd((summary) => this.#record(summary));
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

	/** Starts a new series. Clears any stored matches, even if a series was running. */
	start(options: SeriesOptions = this.#options): void {
		this.#options = normalizeOptions(options);
		this.#matches = [];
		this.#status = 'running';
		this.#stoppedByUser = false;
		for (const listener of [...this.#startListeners]) listener({ ...this.#options });
	}

	/** Starts the series again with the same options. Clears the stored matches. */
	restart(): void {
		this.start(this.#options);
	}

	/** Stops recording, including the automatic restart. The matches played so far stay in {@link getResult}. */
	stop(): void {
		if (this.#status === 'running') this.#status = 'stopped';
		this.#stoppedByUser = true;
	}

	/** Stops listening to the client. */
	dispose(): void {
		this.#unsubscribe();
		this.tracker.detach();
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
	}

	#isOver(): boolean {
		const { games, format } = this.#options;
		if (this.#matches.length >= games) return true;
		if (format !== 'best-of') return false;
		const needed = Math.floor(games / 2) + 1;
		return this.#teams().some((team) => team.wins >= needed);
	}

	#teams(): SeriesTeamResult[] {
		const teams = new Map<string, { result: SeriesTeamResult; possession: number; pressure: number }>();
		let possessionTotal = 0;
		let pressureTotal = 0;
		const get = (name: string) => {
			let entry = teams.get(name);
			if (!entry) {
				entry = { result: { name, wins: 0, goals: 0, possessionPercent: 0, pressurePercent: 0, boostUsed: 0 }, possession: 0, pressure: 0 };
				teams.set(name, entry);
			}
			return entry;
		};

		for (const match of this.#matches) {
			for (const teamNum of [0, 1]) {
				const side = teamSide(teamNum)!;
				const entry = get(teamName(match.teams, teamNum));
				entry.result.goals += match.teams.find((team) => team.TeamNum === teamNum)?.Score ?? 0;
				entry.result.boostUsed += match.boost.teams[side];
				entry.possession += match.possession.seconds[side];
				// Pressure for blue = time in the orange half, and the other way around.
				entry.pressure += teamNum === 0 ? match.fieldDomination.seconds.orangeHalf : match.fieldDomination.seconds.blueHalf;
			}
			get(teamName(match.teams, match.winnerTeamNum)).result.wins++;
			possessionTotal += match.possession.seconds.blue + match.possession.seconds.orange;
			pressureTotal += match.fieldDomination.seconds.blueHalf + match.fieldDomination.seconds.orangeHalf;
		}

		return [...teams.values()]
			.map(({ result, possession, pressure }) => ({
				...result,
				possessionPercent: possessionTotal > 0 ? (possession / possessionTotal) * 100 : 0,
				pressurePercent: pressureTotal > 0 ? (pressure / pressureTotal) * 100 : 0,
			}))
			.sort((a, b) => b.wins - a.wins || b.goals - a.goals);
	}

	#players(): SeriesPlayerResult[] {
		const players = new Map<string, SeriesPlayerResult>();
		for (const match of this.#matches) {
			for (const result of match.playerResults) {
				let total = players.get(result.key);
				if (!total) {
					total = {
						key: result.key,
						Name: result.Name,
						team: result.team,
						matches: 0,
						mvps: 0,
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
						crossbar: { attack: 0, defense: 0, total: 0 },
					};
					players.set(result.key, total);
				}
				total.team = result.team;
				total.matches++;
				if (result.mvp) total.mvps++;
				for (const stat of TOTAL_STATS) total[stat] += result[stat];
				total.boostUsed += result.boostUsed;
				total.airTime += result.airTime;
				total.crossbar.attack += result.crossbar.attack;
				total.crossbar.defense += result.crossbar.defense;
				total.crossbar.total += result.crossbar.total;
			}
		}
		return [...players.values()].sort((a, b) => b.Score - a.Score);
	}

	/** Results so far. Can be called at any time; check `finished` to know if the series is over. */
	getResult(): SeriesResult {
		const teams = this.#teams();
		const players = this.#players();
		const over = this.#status === 'finished' || this.#status === 'stopped';
		const [first, second] = teams;
		const winner = over && first && (!second || first.wins > second.wins) ? first.name : undefined;
		const mvp = (winner ? players.find((player) => player.team === winner) : undefined) ?? players[0];
		return {
			status: this.#status,
			options: { ...this.#options },
			finished: this.#status === 'finished',
			matches: [...this.#matches],
			teams,
			winner,
			players,
			mvp,
		};
	}
}
