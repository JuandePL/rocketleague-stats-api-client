import type { AnyEventListener, Unsubscribe } from '../client.js';
import type { Game, GameTeam, Player, TeamNum } from '../types/common.js';
import type { StatsApiEvent } from '../types/events.js';
import { getMvp, playerKey, teamSide, toPercent, type TeamSplit } from './helpers.js';

/** Anything that delivers every game event, such as `RocketLeagueStatsClient`. */
export interface StatsEventSource {
	onAny(listener: AnyEventListener): Unsubscribe;
}

/** Boost used by one player. */
export interface PlayerBoostUsage {
	/** See {@link playerKey}. */
	key: string;
	Name: string;
	Shortcut: number;
	TeamNum: TeamNum;
	/** Total boost spent (boost is 0–100 per tank, so 250 = two and a half full tanks). */
	boostUsed: number;
}

/** Live stats of the current match. Times only count while the ball is in play. */
export interface MatchStats {
	/** Seconds of play tracked (kickoff countdowns, goal replays and pauses excluded). */
	secondsPlayed: number;
	/** Time each team was the last to touch the ball (`Game.Ball.TeamNum`). */
	possession: { seconds: TeamSplit; percent: TeamSplit };
	/**
	 * Time the ball spent in each half. `pressure` credits the attacking team:
	 * ball 80% in the blue half = 80% pressure for orange.
	 *
	 * `UpdateState` has no ball position, so the half is taken from the last `BallHit`
	 * and kept until the next touch. Time before the first touch of each kickoff is not counted.
	 */
	fieldDomination: {
		seconds: { blueHalf: number; orangeHalf: number };
		percent: { blueHalf: number; orangeHalf: number };
		pressure: TeamSplit;
	};
	/** Boost spent, per player and per team. Needs the `SPECTATOR` `Boost` field, so it stays at 0 when playing. */
	boost: { players: PlayerBoostUsage[]; teams: TeamSplit };
}

/** Final stats of a finished match. */
export interface MatchSummary extends MatchStats {
	/** Only set for online or LAN matches. */
	matchGuid?: string;
	arena?: string;
	/** Teams with their final score, ordered by `TeamNum`. */
	teams: GameTeam[];
	winnerTeamNum: TeamNum;
	overtime: boolean;
	/** Final scoreboard of every player (last `UpdateState`). */
	players: Player[];
	/** Highest score on the winning team. See {@link getMvp}. */
	mvp: Player | undefined;
	endedAt: Date;
}

export type MatchEndListener = (summary: MatchSummary) => void;

/** Ignore clock jumps larger than this (seeking a replay, joining mid-match). */
const MAX_CLOCK_STEP = 5;

/**
 * Tracks ball possession, boost usage and field domination for the current match.
 *
 * ```ts
 * const tracker = new MatchTracker(client);
 * tracker.onMatchEnd((summary) => console.log(summary.possession.percent, summary.mvp?.Name));
 * setInterval(() => console.log(tracker.getStats().fieldDomination.pressure), 5000);
 * ```
 *
 * It resets itself when a new match starts (`MatchCreated` / `MatchInitialized`).
 */
export class MatchTracker {
	readonly #matchEndListeners = new Set<MatchEndListener>();
	#detach: Unsubscribe | undefined;

	// Round state
	#roundActive = false;
	/** `true` once a `RoundStarted` was seen: from then on, round state comes only from events. */
	#sawRoundStart = false;
	#paused = false;
	#ended = false;
	#lastClock: number | undefined;
	#ballHalf: 'blueHalf' | 'orangeHalf' | undefined;
	#lastGame: Game | undefined;
	#lastPlayers: Player[] = [];
	#matchGuid: string | undefined;

	// Accumulators (ticks are converted to seconds with the measured clock time)
	#liveTicks = 0;
	#secondsPlayed = 0;
	#possessionTicks: TeamSplit = { blue: 0, orange: 0 };
	#halfTicks = { blueHalf: 0, orangeHalf: 0 };
	#boost = new Map<string, PlayerBoostUsage>();
	#lastBoost = new Map<string, { boost: number; demolished: boolean }>();

	/** Pass a client to start tracking right away, or call {@link handle} with events yourself. */
	constructor(source?: StatsEventSource) {
		if (source) this.attach(source);
	}

	/** Starts listening to a client. Replaces any previous one. */
	attach(source: StatsEventSource): void {
		this.detach();
		this.#detach = source.onAny((event) => this.handle(event));
	}

	/** Stops listening to the client. The collected stats are kept. */
	detach(): void {
		this.#detach?.();
		this.#detach = undefined;
	}

	/** `true` after `MatchEnded`, until the next match starts. */
	get matchEnded(): boolean {
		return this.#ended;
	}

	/** Called with the final stats when a match ends. Returns a function that removes the listener. */
	onMatchEnd(listener: MatchEndListener): Unsubscribe {
		this.#matchEndListeners.add(listener);
		return () => this.#matchEndListeners.delete(listener);
	}

	/** Clears every stat, as if a new match had started. */
	reset(): void {
		this.#roundActive = false;
		this.#sawRoundStart = false;
		this.#paused = false;
		this.#ended = false;
		this.#lastClock = undefined;
		this.#ballHalf = undefined;
		this.#lastGame = undefined;
		this.#lastPlayers = [];
		this.#matchGuid = undefined;
		this.#liveTicks = 0;
		this.#secondsPlayed = 0;
		this.#possessionTicks = { blue: 0, orange: 0 };
		this.#halfTicks = { blueHalf: 0, orangeHalf: 0 };
		this.#boost.clear();
		this.#lastBoost.clear();
	}

	/** Feeds one event. Called automatically for the attached client. */
	handle(event: StatsApiEvent): void {
		switch (event.Event) {
			case 'MatchCreated':
			case 'MatchInitialized':
				this.reset();
				break;
			case 'RoundStarted':
				this.#roundActive = true;
				this.#sawRoundStart = true;
				this.#ballHalf = undefined; // kickoff: ball at center
				break;
			case 'CountdownBegin':
			case 'GoalScored':
				this.#roundActive = false;
				this.#ballHalf = undefined;
				break;
			case 'MatchPaused':
				this.#paused = true;
				break;
			case 'MatchUnpaused':
				this.#paused = false;
				break;
			case 'BallHit':
				if (!this.#lastGame?.bReplay) this.#ballHalf = event.Data.Ball.Location.Y < 0 ? 'blueHalf' : 'orangeHalf';
				break;
			case 'UpdateState':
				if (!this.#ended) this.#tick(event.Data.Game, event.Data.Players, event.Data.MatchGuid);
				break;
			case 'MatchEnded':
				if (!this.#ended) this.#end(event.Data.WinnerTeamNum);
				break;
		}
	}

	#tick(game: Game, players: Player[], matchGuid: string | undefined): void {
		this.#lastGame = game;
		this.#lastPlayers = players;
		this.#matchGuid = matchGuid ?? this.#matchGuid;
		if (game.bReplay) return; // goal replays repeat old ticks

		this.#trackBoost(players);

		const clockStep = this.#lastClock === undefined ? 0 : Math.abs(game.TimeSeconds - this.#lastClock);
		this.#lastClock = game.TimeSeconds;
		// Joined mid-round (no RoundStarted seen yet): the clock moving means the ball is in play.
		if (!this.#sawRoundStart && !this.#paused && clockStep > 0 && clockStep <= MAX_CLOCK_STEP) this.#roundActive = true;
		if (!this.#roundActive || this.#paused) return;

		this.#liveTicks++;
		if (clockStep <= MAX_CLOCK_STEP) this.#secondsPlayed += clockStep;
		const side = teamSide(game.Ball.TeamNum);
		if (side) this.#possessionTicks[side]++;
		if (this.#ballHalf) this.#halfTicks[this.#ballHalf]++;
	}

	#trackBoost(players: Player[]): void {
		for (const player of players) {
			if (typeof player.Boost !== 'number') continue;
			const key = playerKey(player);
			const demolished = player.bDemolished === true;
			const previous = this.#lastBoost.get(key);
			this.#lastBoost.set(key, { boost: player.Boost, demolished });

			let usage = this.#boost.get(key);
			if (!usage) {
				usage = { key, Name: player.Name, Shortcut: player.Shortcut, TeamNum: player.TeamNum, boostUsed: 0 };
				this.#boost.set(key, usage);
			}
			usage.TeamNum = player.TeamNum;
			// A demolition empties the tank without using it.
			if (previous && !demolished && !previous.demolished && player.Boost < previous.boost) {
				usage.boostUsed += previous.boost - player.Boost;
			}
		}
	}

	/** Current stats. Can be called at any time during the match. */
	getStats(): MatchStats {
		const seconds = (ticks: number) => (this.#liveTicks > 0 ? (ticks / this.#liveTicks) * this.#secondsPlayed : 0);

		const halfSeconds = { blueHalf: seconds(this.#halfTicks.blueHalf), orangeHalf: seconds(this.#halfTicks.orangeHalf) };
		const halfPercent = toPercent({ blue: this.#halfTicks.blueHalf, orange: this.#halfTicks.orangeHalf });

		const players = [...this.#boost.values()].map((usage) => ({ ...usage }));
		const teams: TeamSplit = { blue: 0, orange: 0 };
		for (const usage of players) {
			const side = teamSide(usage.TeamNum);
			if (side) teams[side] += usage.boostUsed;
		}

		return {
			secondsPlayed: this.#secondsPlayed,
			possession: {
				seconds: { blue: seconds(this.#possessionTicks.blue), orange: seconds(this.#possessionTicks.orange) },
				percent: toPercent(this.#possessionTicks),
			},
			fieldDomination: {
				seconds: halfSeconds,
				percent: { blueHalf: halfPercent.blue, orangeHalf: halfPercent.orange },
				// Ball in the blue half = orange is attacking.
				pressure: { blue: halfPercent.orange, orange: halfPercent.blue },
			},
			boost: { players, teams },
		};
	}

	#end(winnerTeamNum: TeamNum): void {
		this.#ended = true;
		this.#roundActive = false;
		const game = this.#lastGame;
		const players = [...this.#lastPlayers];
		const summary: MatchSummary = {
			...this.getStats(),
			matchGuid: this.#matchGuid,
			arena: game?.Arena,
			teams: game ? [...game.Teams].sort((a, b) => a.TeamNum - b.TeamNum).map((team) => ({ ...team })) : [],
			winnerTeamNum,
			overtime: game?.bOvertime ?? false,
			players,
			mvp: getMvp(players, winnerTeamNum),
			endedAt: new Date(),
		};
		for (const listener of [...this.#matchEndListeners]) listener(summary);
	}
}
