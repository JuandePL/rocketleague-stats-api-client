import type { Unsubscribe } from '../client.js';
import type { TeamNum } from '../types/common.js';
import { percentOf, perMinute, teamName, teamSide, TOTAL_STATS } from './helpers.js';
import { MatchTracker, type CrossbarHits, type MatchSummary, type MatchTrackerOptions, type StatsEventSource } from './match.js';

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
	/** Teams sorted by wins, then goals. */
	teams: SeriesTeamResult[];
	/** Team with the most wins once the series is over. `undefined` while running, or on a tie. */
	winner: string | undefined;
	/** Players sorted by total score. */
	players: SeriesPlayerResult[];
	/** Highest total score on the winning team (or overall if there is no winner yet). */
	mvp: SeriesPlayerResult | undefined;
}

/** What the series totals need from a match. A match in progress has no `winnerTeamNum` yet. */
type CountedMatch = Pick<MatchSummary, 'teams' | 'boost' | 'possession' | 'playerResults' | 'secondsPlayed'> & { winnerTeamNum?: TeamNum };

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
		this.tracker = new MatchTracker(source, { identifyPlayer: options.identifyPlayer });
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
		return this.#teams(this.#matches).some((team) => team.wins >= needed);
	}

	#teams(matches: readonly CountedMatch[]): SeriesTeamResult[] {
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
				const entry = get(teamName(match.teams, teamNum));
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
			if (match.winnerTeamNum !== undefined) get(teamName(match.teams, match.winnerTeamNum)).result.wins++;
			possessionTotal += match.possession.seconds.blue + match.possession.seconds.orange;
		}

		return [...teams.values()]
			.map(({ result, possession, decided, playerGoals }) => ({
				...result,
				winPercent: percentOf(result.wins, decided),
				shootingPercent: percentOf(playerGoals, result.shots),
				boostPerMinute: perMinute(result.boostUsed, result.secondsPlayed),
				possessionPercent: percentOf(possession, possessionTotal),
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
	 * - With no match being played, or when the series is `idle` or `stopped`, it is the same as `getResult()`.
	 */
	getLiveResult(): SeriesResult {
		if (!this.tracker.matchInProgress) return this.getResult();
		const current: CountedMatch = { ...this.tracker.getStats(), teams: this.tracker.getTeams(), playerResults: this.tracker.getPlayerResults() };
		if (this.#status === 'running') return this.#result(this.#matches, [...this.#matches, current]);
		if (this.#status === 'finished' && this.#autoStart && !this.#stoppedByUser) return this.#result([], [current], 'running');
		return this.getResult();
	}

	#result(matches: MatchSummary[], counted: readonly CountedMatch[] = matches, status: SeriesStatus = this.#status): SeriesResult {
		const teams = this.#teams(counted);
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
			teams,
			winner,
			players,
			mvp,
		};
	}
}
