import type { Unsubscribe } from '../client.js';
import type { TeamNum } from '../types/common.js';
import { playerKey, teamSide, TOTAL_STATS } from './helpers.js';
import { MatchTracker, type MatchSummary, type StatsEventSource } from './match.js';

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

/** A player's totals over the series. */
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
}

export interface SeriesResult {
	status: SeriesStatus;
	options: Required<SeriesOptions>;
	/** `true` when the series reached its end (not when it was stopped early). */
	finished: boolean;
	/** Every recorded match, in order. */
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

export type SeriesMatchListener = (match: MatchSummary, series: SeriesResult) => void;
export type SeriesEndListener = (series: SeriesResult) => void;

/** Name of the team that played as `teamNum` in a match. */
function teamName(match: MatchSummary, teamNum: TeamNum): string {
	const name = match.teams.find((team) => team.TeamNum === teamNum)?.Name;
	return name || (teamNum === 0 ? 'Blue' : teamNum === 1 ? 'Orange' : `Team ${teamNum}`);
}

/**
 * Esports mode: records a series of matches in memory and gives you the results.
 *
 * ```ts
 * const series = new EsportsSeries(client);
 * series.onMatchEnd((match, result) => console.log(`Game ${result.matches.length}: ${match.mvp?.Name} MVP`));
 * series.onSeriesEnd((result) => console.log(`${result.winner} wins the series`));
 * series.start({ games: 5 }); // best of 5
 * ```
 *
 * Only matches that end (`MatchEnded`) while the series is running are recorded.
 * Every {@link start} or {@link restart} clears the stored matches.
 */
export class EsportsSeries {
	/** Live stats of the match being played. */
	readonly tracker: MatchTracker;

	#status: SeriesStatus = 'idle';
	#options: Required<SeriesOptions> = { games: 1, format: 'best-of' };
	#matches: MatchSummary[] = [];
	readonly #matchListeners = new Set<SeriesMatchListener>();
	readonly #endListeners = new Set<SeriesEndListener>();
	readonly #unsubscribe: Unsubscribe;

	constructor(source?: StatsEventSource) {
		this.tracker = new MatchTracker(source);
		this.#unsubscribe = this.tracker.onMatchEnd((summary) => this.#record(summary));
	}

	get status(): SeriesStatus {
		return this.#status;
	}

	/** Recorded matches, in order. */
	get matches(): readonly MatchSummary[] {
		return this.#matches;
	}

	/** Starts a new series. Clears any stored matches, even if a series was running. */
	start(options: SeriesOptions): void {
		const games = options.games;
		if (!Number.isInteger(games) || games < 1) throw new RangeError(`games must be a positive integer, got ${games}.`);
		this.#options = { games, format: options.format ?? 'best-of' };
		this.#matches = [];
		this.#status = 'running';
	}

	/** Starts the series again with the same options. Clears the stored matches. */
	restart(): void {
		this.start(this.#options);
	}

	/** Stops recording. The matches played so far are kept and available in {@link getResult}. */
	stop(): void {
		if (this.#status === 'running') this.#status = 'stopped';
	}

	/** Stops listening to the client. */
	dispose(): void {
		this.#unsubscribe();
		this.tracker.detach();
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
				const entry = get(teamName(match, teamNum));
				entry.result.goals += match.teams.find((team) => team.TeamNum === teamNum)?.Score ?? 0;
				entry.result.boostUsed += match.boost.teams[side];
				entry.possession += match.possession.seconds[side];
				// Pressure for blue = time in the orange half, and the other way around.
				entry.pressure += teamNum === 0 ? match.fieldDomination.seconds.orangeHalf : match.fieldDomination.seconds.blueHalf;
			}
			get(teamName(match, match.winnerTeamNum)).result.wins++;
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
			const mvpKey = match.mvp ? playerKey(match.mvp) : undefined;
			const boost = new Map(match.boost.players.map((usage) => [usage.key, usage.boostUsed]));
			for (const player of match.players) {
				const key = playerKey(player);
				let total = players.get(key);
				if (!total) {
					total = {
						key,
						Name: player.Name,
						team: '',
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
					};
					players.set(key, total);
				}
				total.team = teamName(match, player.TeamNum);
				total.matches++;
				if (key === mvpKey) total.mvps++;
				for (const stat of TOTAL_STATS) total[stat] += player[stat] ?? 0;
				total.boostUsed += boost.get(key) ?? 0;
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
