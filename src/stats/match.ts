import type { AnyEventListener, Unsubscribe } from '../client.js';
import type { Game, GameTeam, Player, PlayerRef, TeamNum } from '../types/common.js';
import type { StatsApiEvent } from '../types/events.js';
import { getMvp, playerKey, teamName, teamSide, toPercent, TOTAL_STATS, type TeamSplit } from './helpers.js';

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

/** Times a player sent the ball against the crossbar or a post (`CrossbarHit`). */
export interface CrossbarHits {
	/** On the opponent's goal. */
	attack: number;
	/** On the player's own goal. */
	defense: number;
	total: number;
}

/** Stats the tracker computes for one player (the scoreboard ones come from the game). */
export interface TrackedPlayerStats extends PlayerBoostUsage {
	/**
	 * Seconds in the air: neither on the ground nor on a wall, with a car that isn't demolished.
	 * Needs the `SPECTATOR` `bOnGround` / `bOnWall` fields. The game reports `bOnGround` only with
	 * 3 or more wheels down, so driving on 2 wheels counts as air time.
	 */
	airTime: number;
	/** Seconds driving on a wall (`SPECTATOR` `bOnWall`), with a car that isn't demolished. */
	onWallTime: number;
	crossbar: CrossbarHits;
}

/** Everything about one player in one match: the final scoreboard plus the tracked stats. */
export interface MatchPlayerResult extends TrackedPlayerStats {
	PrimaryId: string;
	/** Name of the player's team (`Game.Teams[].Name`). */
	team: string;
	/** `true` for the match MVP. */
	mvp: boolean;
	Score: number;
	Goals: number;
	Shots: number;
	Assists: number;
	Saves: number;
	Touches: number;
	CarTouches: number;
	Demos: number;
}

/** Live stats of the current match. Times only count while the ball is in play and the match is not paused. */
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
	/** Boost, air time and crossbar hits of every player seen in the match. */
	players: TrackedPlayerStats[];
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
	/** Final scoreboard of every player, as sent by the game (last `UpdateState`). */
	scoreboard: Player[];
	/** Every player of the final scoreboard with their tracked stats, sorted by score. */
	playerResults: MatchPlayerResult[];
	/** Highest score on the winning team. See {@link getMvp}. */
	mvp: MatchPlayerResult | undefined;
	endedAt: Date;
}

export type MatchEndListener = (summary: MatchSummary) => void;

/** Ignore clock jumps larger than this (seeking a replay, joining mid-match). */
const MAX_CLOCK_STEP = 5;

interface PlayerAccumulator {
	key: string;
	Name: string;
	Shortcut: number;
	TeamNum: TeamNum;
	boostUsed: number;
	airTicks: number;
	wallTicks: number;
	crossbar: CrossbarHits;
	lastBoost: { boost: number; demolished: boolean } | undefined;
}

/** `true` when the car is airborne (only known while spectating). */
/** `true` when the car is driving on a wall (only known while spectating). */
function isOnWall(player: Player): boolean {
	return player.bHasCar !== false && player.bDemolished !== true && player.bOnWall === true;
}

function isInAir(player: Player): boolean {
	return player.bHasCar !== false && player.bDemolished !== true && player.bOnGround === false && player.bOnWall === false;
}

/**
 * Tracks ball possession, boost usage, field domination, air time and crossbar hits for the current match.
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
	#players = new Map<string, PlayerAccumulator>();

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

	/**
	 * `true` between `MatchPaused` and `MatchUnpaused`. While paused, every stat is frozen:
	 * time, possession, field domination, boost usage, air time, wall time and crossbar hits.
	 */
	get paused(): boolean {
		return this.#paused;
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
		this.#players.clear();
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
				if (this.#counting()) this.#ballHalf = event.Data.Ball.Location.Y < 0 ? 'blueHalf' : 'orangeHalf';
				break;
			case 'CrossbarHit':
				if (this.#counting()) this.#crossbarHit(event.Data.BallLastTouch.Player, event.Data.BallLocation.Y);
				break;
			case 'UpdateState':
				if (!this.#ended) this.#tick(event.Data.Game, event.Data.Players, event.Data.MatchGuid);
				break;
			case 'MatchEnded':
				if (!this.#ended) this.#end(event.Data.WinnerTeamNum);
				break;
		}
	}

	/** `false` while paused, during goal replays and after the match ended. */
	#counting(): boolean {
		return !this.#paused && !this.#ended && !this.#lastGame?.bReplay;
	}

	#accumulator(player: PlayerRef & { PrimaryId?: string }): PlayerAccumulator {
		const key = playerKey(player);
		let entry = this.#players.get(key);
		if (!entry) {
			entry = {
				key,
				Name: player.Name,
				Shortcut: player.Shortcut,
				TeamNum: player.TeamNum,
				boostUsed: 0,
				airTicks: 0,
				wallTicks: 0,
				crossbar: { attack: 0, defense: 0, total: 0 },
				lastBoost: undefined,
			};
			this.#players.set(key, entry);
		}
		entry.TeamNum = player.TeamNum;
		return entry;
	}

	#crossbarHit(ref: PlayerRef, ballY: number): void {
		// Events only carry a PlayerRef: find the full player to get the same key as in UpdateState.
		const player =
			this.#lastPlayers.find((p) => p.Name === ref.Name && p.Shortcut === ref.Shortcut && p.TeamNum === ref.TeamNum) ?? ref;
		const entry = this.#accumulator(player);
		// The blue goal is on the negative Y side.
		const goalTeam = ballY < 0 ? 0 : 1;
		if (goalTeam === ref.TeamNum) entry.crossbar.defense++;
		else entry.crossbar.attack++;
		entry.crossbar.total++;
	}

	#tick(game: Game, players: Player[], matchGuid: string | undefined): void {
		this.#lastGame = game;
		this.#lastPlayers = players;
		this.#matchGuid = matchGuid ?? this.#matchGuid;
		if (game.bReplay) return; // goal replays repeat old ticks

		const clockStep = this.#lastClock === undefined ? 0 : Math.abs(game.TimeSeconds - this.#lastClock);
		this.#lastClock = game.TimeSeconds;

		const entries = players.map((player) => [player, this.#accumulator(player)] as const);

		// Paused: nothing is counted. Boost values are still recorded so nothing jumps on unpause.
		for (const [player, entry] of entries) this.#trackBoost(player, entry, !this.#paused);
		if (this.#paused) return;

		// Joined mid-round (no RoundStarted seen yet): the clock moving means the ball is in play.
		if (!this.#sawRoundStart && clockStep > 0 && clockStep <= MAX_CLOCK_STEP) this.#roundActive = true;
		if (!this.#roundActive) return;

		this.#liveTicks++;
		if (clockStep <= MAX_CLOCK_STEP) this.#secondsPlayed += clockStep;
		const side = teamSide(game.Ball.TeamNum);
		if (side) this.#possessionTicks[side]++;
		if (this.#ballHalf) this.#halfTicks[this.#ballHalf]++;
		for (const [player, entry] of entries) {
			if (isInAir(player)) entry.airTicks++;
			else if (isOnWall(player)) entry.wallTicks++;
		}
	}

	#trackBoost(player: Player, entry: PlayerAccumulator, count: boolean): void {
		if (typeof player.Boost !== 'number') return;
		const demolished = player.bDemolished === true;
		const previous = entry.lastBoost;
		entry.lastBoost = { boost: player.Boost, demolished };
		// A demolition empties the tank without using it.
		if (count && previous && !demolished && !previous.demolished && player.Boost < previous.boost) {
			entry.boostUsed += previous.boost - player.Boost;
		}
	}

	/** Current stats. Can be called at any time during the match. */
	getStats(): MatchStats {
		const seconds = (ticks: number) => (this.#liveTicks > 0 ? (ticks / this.#liveTicks) * this.#secondsPlayed : 0);

		const halfSeconds = { blueHalf: seconds(this.#halfTicks.blueHalf), orangeHalf: seconds(this.#halfTicks.orangeHalf) };
		const halfPercent = toPercent({ blue: this.#halfTicks.blueHalf, orange: this.#halfTicks.orangeHalf });

		const players: TrackedPlayerStats[] = [...this.#players.values()].map((entry) => ({
			key: entry.key,
			Name: entry.Name,
			Shortcut: entry.Shortcut,
			TeamNum: entry.TeamNum,
			boostUsed: entry.boostUsed,
			airTime: seconds(entry.airTicks),
			onWallTime: seconds(entry.wallTicks),
			crossbar: { ...entry.crossbar },
		}));
		const boostTeams: TeamSplit = { blue: 0, orange: 0 };
		for (const player of players) {
			const side = teamSide(player.TeamNum);
			if (side) boostTeams[side] += player.boostUsed;
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
			boost: {
				players: players.map(({ key, Name, Shortcut, TeamNum, boostUsed }) => ({ key, Name, Shortcut, TeamNum, boostUsed })),
				teams: boostTeams,
			},
			players,
		};
	}

	#end(winnerTeamNum: TeamNum): void {
		this.#ended = true;
		this.#roundActive = false;
		const game = this.#lastGame;
		const teams = game ? [...game.Teams].sort((a, b) => a.TeamNum - b.TeamNum).map((team) => ({ ...team })) : [];
		const scoreboard = [...this.#lastPlayers];
		const stats = this.getStats();
		const tracked = new Map(stats.players.map((player) => [player.key, player]));
		const mvpKey = (() => {
			const mvp = getMvp(scoreboard, winnerTeamNum);
			return mvp ? playerKey(mvp) : undefined;
		})();

		const playerResults: MatchPlayerResult[] = scoreboard
			.map((player) => {
				const key = playerKey(player);
				const own = tracked.get(key);
				const result: MatchPlayerResult = {
					key,
					PrimaryId: player.PrimaryId,
					Name: player.Name,
					Shortcut: player.Shortcut,
					TeamNum: player.TeamNum,
					team: teamName(teams, player.TeamNum),
					mvp: key === mvpKey,
					Score: 0,
					Goals: 0,
					Shots: 0,
					Assists: 0,
					Saves: 0,
					Touches: 0,
					CarTouches: 0,
					Demos: 0,
					boostUsed: own?.boostUsed ?? 0,
					airTime: own?.airTime ?? 0,
					onWallTime: own?.onWallTime ?? 0,
					crossbar: own ? { ...own.crossbar } : { attack: 0, defense: 0, total: 0 },
				};
				for (const stat of TOTAL_STATS) result[stat] = player[stat] ?? 0;
				return result;
			})
			.sort((a, b) => b.Score - a.Score);

		const summary: MatchSummary = {
			...stats,
			matchGuid: this.#matchGuid,
			arena: game?.Arena,
			teams,
			winnerTeamNum,
			overtime: game?.bOvertime ?? false,
			scoreboard,
			playerResults,
			mvp: playerResults.find((player) => player.mvp),
			endedAt: new Date(),
		};
		for (const listener of [...this.#matchEndListeners]) listener(summary);
	}
}
