import type { AnyEventListener, Unsubscribe } from '../client.js';
import type { Game, GameTeam, Player, PlayerRef, TeamNum } from '../types/common.js';
import type { EventName, GoalScoredData, StatsApiEvent, StatsApiEventOf } from '../types/events.js';
import {
	getMvp,
	isBot,
	percentOf,
	perMinute,
	playerKey,
	teamName,
	teamSide,
	toPercent,
	TOTAL_STATS,
	type IdentifiablePlayer,
	type PlayerIdentifier,
	type TeamSplit,
} from './helpers.js';

/** Anything that delivers every game event, such as `RocketLeagueStatsClient`. */
export interface StatsEventSource {
	onAny(listener: AnyEventListener): Unsubscribe;
}

/** Boost used by one player. */
export interface PlayerBoostUsage {
	/** Identifies the player across ticks and matches. See {@link playerKey} and the `identifyPlayer` option. */
	key: string;
	/** Platform id in the format `Platform|Uid|Splitscreen` (e.g. `"Steam|123|0"`). Bots have `"Unknown|0|0"`. */
	PrimaryId: string;
	/** `true` for bots. */
	bot: boolean;
	/** Latest name seen. */
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
	 * 3 or more wheels down, so driving on 2 wheels counts as air time. Driving on the ceiling counts
	 * as ground (the game sends `bOnGround: true`, `bOnWall: false`).
	 */
	airTime: number;
	/** Seconds driving on a wall (`SPECTATOR` `bOnWall`), with a car that isn't demolished. */
	onWallTime: number;
	/**
	 * Average speed in km/h, the unit the game sends. Use `toMph()` (or `convertSpeed()`) for mph.
	 * Only live play with a car that isn't demolished counts. Needs the `SPECTATOR` `Speed` field;
	 * `0` when it was never sent.
	 */
	averageSpeed: number;
	/** Seconds the player's speed was measured: the time `averageSpeed` covers. */
	drivingTime: number;
	crossbar: CrossbarHits;
}

/** A point in time during a match. Compare two of them with `timeBetween()`. */
export interface MatchMoment {
	/** Order of the moment in the match: increases with every event received. */
	sequence: number;
	/** Match clock: seconds remaining, or seconds into overtime when `overtime` is `true`. */
	timeSeconds: number;
	overtime: boolean;
	/** The match clock as text: `"02:35"` remaining, or `"+01:10"` in overtime (see `formatMatchClock`). */
	clock: string;
	/** Seconds of play tracked until then (same measure as `MatchStats.secondsPlayed`). */
	secondsPlayed: number;
	/** Wall-clock time. */
	date: Date;
}

/** When a player left: the last `UpdateState` they were in. */
export type LeftAt = MatchMoment;

/** One event of the match with the moment it arrived. Narrow it with `entry.event.Event`. */
export type TimelineEntry<E extends EventName = EventName> = {
	[K in E]: { event: StatsApiEventOf<K>; moment: MatchMoment };
}[E];

/** A goal of the match with the moment it was scored. */
export interface GoalRecord {
	moment: MatchMoment;
	data: GoalScoredData;
}

export interface FormatMatchClockOptions {
	/** Pad the minutes to two digits: `"02:35"` instead of `"2:35"`. @default true */
	padMinutes?: boolean;
}

/**
 * Formats the match clock: `"02:35"`, or `"+01:10"` in overtime.
 * Pass `{ padMinutes: false }` for `"2:35"` / `"+1:10"`.
 */
export function formatMatchClock(timeSeconds: number, overtime = false, options: FormatMatchClockOptions = {}): string {
	const total = Math.max(0, Math.round(timeSeconds));
	const minutes = String(Math.floor(total / 60));
	const clock = `${(options.padMinutes ?? true) ? minutes.padStart(2, '0') : minutes}:${String(total % 60).padStart(2, '0')}`;
	return overtime ? `+${clock}` : clock;
}

/**
 * A stretch of time a player was in the match, on one team. A new session starts every time the player
 * joins (or comes back) and every time they change team.
 */
export interface PlayerSession {
	TeamNum: TeamNum;
	/** Name of the team (`Game.Teams[].Name`). */
	team: string;
	/** First `UpdateState` the player was in. */
	joinedAt: MatchMoment;
	/**
	 * Last `UpdateState` the player was in, so the real exit is at most one tick later.
	 * Not set when the player was still in the match at the end (or right now, for live results).
	 */
	leftAt?: MatchMoment;
	/** `true` when the session ended because the player changed team, not because they left. */
	switchedTeam: boolean;
}

/**
 * Everything about one player in one match: the scoreboard plus the tracked stats.
 * Players who left before the end keep the stats they had when they were last seen.
 */
export interface MatchPlayerResult extends TrackedPlayerStats {
	/** Name of the player's team (`Game.Teams[].Name`). */
	team: string;
	/** `true` for the match MVP. Players who left before the end can't be MVP. */
	mvp: boolean;
	/** `true` if the player was no longer in the match when it ended (left, rage quit, disconnected). */
	leftEarly: boolean;
	/** When the player was last seen in the match. Only set when `leftEarly` is `true`. */
	leftAt?: LeftAt;
	/** Every time the player was in the match, in order, with the team they were on. */
	sessions: PlayerSession[];
	/** Times the player entered the match, the first time included (team changes don't count). */
	joins: number;
	/** Times the player left before the end (team changes don't count). */
	leaves: number;
	/**
	 * `true` if the player's team (the last one they were on) won the match. Not set while the match is
	 * being played.
	 */
	won?: boolean;
	/**
	 * Seconds of play the player was in the match: the sum of their `sessions`, same measure as
	 * `MatchStats.secondsPlayed`. Lower than the match's for players who joined late or left early.
	 */
	secondsPlayed: number;
	Score: number;
	Goals: number;
	Shots: number;
	Assists: number;
	Saves: number;
	Touches: number;
	CarTouches: number;
	Demos: number;
	/** Shots that went in: `Goals` / `Shots`, 0–100. `0` without shots. */
	shootingPercent: number;
	/**
	 * Goals the player scored or assisted, over the goals of their team (`Score` of the last team they were on),
	 * 0–100. `0` when the team didn't score. Can go over 100 for a player who scored for both teams.
	 */
	goalParticipation: number;
	/** `boostUsed` per minute of `secondsPlayed`. Needs the `SPECTATOR` `Boost` field, like `boostUsed`. */
	boostPerMinute: number;
}

/** Everything about one team in one match. */
export interface MatchTeamResult {
	TeamNum: TeamNum;
	/** `Game.Teams[].Name`. */
	name: string;
	/** Team score, own goals of the other team included. */
	goals: number;
	/** Shots of every player who played for the team, the ones who left included. */
	shots: number;
	/**
	 * Shots that went in: goals scored by the team's players over their shots, 0–100. Own goals of the
	 * other team don't count, since they are not shots. `0` without shots.
	 */
	shootingPercent: number;
	/** `true` if the team won. Not set while the match is being played. */
	won?: boolean;
	/** Boost used by the team's players. Needs the `SPECTATOR` `Boost` field. */
	boostUsed: number;
	/** `boostUsed` per minute of the match's `secondsPlayed` (the whole team, not per player). */
	boostPerMinute: number;
	/** Share of possession, 0–100. */
	possessionPercent: number;
}

/** Live stats of the current match. Times only count while the ball is in play and the match is not paused. */
export interface MatchStats {
	/** Seconds of play tracked (kickoff countdowns, goal replays and pauses excluded). */
	secondsPlayed: number;
	/** Time each team was the last to touch the ball (`Game.Ball.TeamNum`). */
	possession: { seconds: TeamSplit; percent: TeamSplit };
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
	/** Final scoreboard, as sent by the game (last `UpdateState`). Players who left are not in it. */
	scoreboard: Player[];
	/**
	 * Every player seen during the match, sorted by score: the final scoreboard, plus the players
	 * who left before the end (`leftEarly: true`) with the stats they had when they left.
	 */
	playerResults: MatchPlayerResult[];
	/** Results of each team, ordered by `TeamNum`. */
	teamResults: MatchTeamResult[];
	/** Highest score on the winning team. See {@link getMvp}. */
	mvp: MatchPlayerResult | undefined;
	endedAt: Date;
	/** The moment the match ended (`MatchEnded`). */
	endMoment: MatchMoment;
	/** Every goal, in order. */
	goals: GoalRecord[];
	/** Every event of the match except `UpdateState`, in order, from `MatchInitialized` to `MatchEnded`. */
	timeline: TimelineEntry[];
}

export type MatchEndListener = (summary: MatchSummary) => void;
export type MatchStartListener = () => void;

/** Ignore clock jumps larger than this (seeking a replay, joining mid-match). */
const MAX_CLOCK_STEP = 5;

interface PlayerAccumulator {
	key: string;
	PrimaryId: string;
	bot: boolean;
	Name: string;
	Shortcut: number;
	TeamNum: TeamNum;
	boostUsed: number;
	airTicks: number;
	wallTicks: number;
	/** Sum of `Speed` over the ticks counted in `speedTicks`. */
	speedSum: number;
	speedTicks: number;
	crossbar: CrossbarHits;
	lastBoost: { boost: number; demolished: boolean } | undefined;
	/** Last `UpdateState` entry of the player: their scoreboard if they leave before the end. */
	lastSeen: Player | undefined;
	/** When `lastSeen` was recorded. */
	lastSeenAt: MatchMoment | undefined;
	/** Times in the match. The last one is open (no `leftAt`) while the player is in. */
	sessions: { TeamNum: TeamNum; joinedAt: MatchMoment; leftAt?: MatchMoment; switchedTeam: boolean }[];
}

export interface MatchTrackerOptions {
	/**
	 * How to identify a player across ticks and matches. Defaults to {@link playerKey}: the `PrimaryId`
	 * for real accounts, `"bot:" + name` for bots. Use it to merge accounts or use your own ids.
	 * Players from events other than `UpdateState` may come without `PrimaryId`.
	 */
	identifyPlayer?: PlayerIdentifier;
}

/** `true` when the car is driving on a wall (only known while spectating). */
function isOnWall(player: Player): boolean {
	return player.bHasCar !== false && player.bDemolished !== true && player.bOnWall === true;
}

/** `true` when the player has a car that isn't demolished and its speed is known (only while spectating). */
function hasSpeed(player: Player): player is Player & { Speed: number } {
	return player.bHasCar !== false && player.bDemolished !== true && typeof player.Speed === 'number' && Number.isFinite(player.Speed);
}

/** `true` when the `SPECTATOR` car fields are sent for this player. */
function hasCarState(player: Player): boolean {
	return typeof player.Boost === 'number' || typeof player.Speed === 'number' || player.bOnGround !== undefined || player.bOnWall !== undefined;
}

/**
 * `true` when the car is airborne (only known while spectating). A missing `bOnGround` / `bOnWall`
 * counts as `false`, as long as the player's other car fields are sent.
 */
function isInAir(player: Player): boolean {
	return (
		hasCarState(player) && player.bHasCar !== false && player.bDemolished !== true && player.bOnGround !== true && player.bOnWall !== true
	);
}

/**
 * Tracks ball possession, boost usage, air time, wall time and crossbar hits for the current match.
 *
 * ```ts
 * const tracker = new MatchTracker(client);
 * tracker.onMatchEnd((summary) => console.log(summary.possession.percent, summary.mvp?.Name));
 * setInterval(() => console.log(tracker.getStats().possession.percent), 5000);
 * ```
 *
 * It resets itself when a new match starts (`MatchCreated` / `MatchInitialized`).
 */
export class MatchTracker {
	readonly #matchEndListeners = new Set<MatchEndListener>();
	readonly #matchStartListeners = new Set<MatchStartListener>();
	#detach: Unsubscribe | undefined;

	// Round state
	#roundActive = false;
	/** `true` once a `RoundStarted` was seen: from then on, round state comes only from events. */
	#sawRoundStart = false;
	#paused = false;
	#ended = false;
	/** `true` once `MatchInitialized` (or a `RoundStarted`) was seen in the current match. */
	#started = false;
	/** `true` after `MatchCreated`: the players are in the lobby until `MatchInitialized`. */
	#inLobby = false;
	/** `false` after a counted `CrossbarHit` until the ball is touched again: one hit per touch. */
	#crossbarArmed = true;
	#winnerTeamNum: TeamNum | undefined;
	#lastClock: number | undefined;
	#lastGame: Game | undefined;
	#lastPlayers: Player[] = [];
	#matchGuid: string | undefined;

	// Accumulators (ticks are converted to seconds with the measured clock time)
	#liveTicks = 0;
	#secondsPlayed = 0;
	#possessionTicks: TeamSplit = { blue: 0, orange: 0 };
	#players = new Map<string, PlayerAccumulator>();
	#timeline: TimelineEntry[] = [];
	#sequence = 0;

	/** Pass a client to start tracking right away, or call {@link handle} with events yourself. */
	readonly #identify: PlayerIdentifier;

	/** Pass a client to start tracking right away, or call {@link handle} with events yourself. */
	constructor(source?: StatsEventSource, options: MatchTrackerOptions = {}) {
		this.#identify = options.identifyPlayer ?? playerKey;
		if (source) this.attach(source);
	}

	/** The key of a player, as used in `key` and in every result. */
	keyOf(player: IdentifiablePlayer): string {
		return this.#identify(player);
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
	 * time, possession, boost usage, air time, wall time and crossbar hits.
	 */
	get paused(): boolean {
		return this.#paused;
	}

	/**
	 * `true` from `MatchInitialized` until `MatchEnded`: the match is being played. Unlike {@link matchInProgress},
	 * it is `false` in the lobby after `MatchCreated`, before the match starts.
	 *
	 * If the tracker joins mid-match (no `MatchCreated` or `MatchInitialized` seen), it is `true` from the first
	 * `UpdateState`. If only `MatchInitialized` was missed, it is `true` from the first `RoundStarted`.
	 */
	get matchStarted(): boolean {
		return this.#started && !this.#ended;
	}

	/** `true` after `MatchEnded`, until the next match starts. */
	get matchEnded(): boolean {
		return this.#ended;
	}

	/**
	 * `true` while a match is being tracked: an `UpdateState` was received and `MatchEnded` wasn't.
	 * It is already `true` in the lobby after `MatchCreated`, before the match starts: to know if the match
	 * is being played, use {@link matchStarted}.
	 */
	get matchInProgress(): boolean {
		return this.#lastGame !== undefined && !this.#ended;
	}

	/** Teams of the current match with their score, ordered by `TeamNum`. Empty before the first `UpdateState`. */
	getTeams(): GameTeam[] {
		const game = this.#lastGame;
		return game ? [...game.Teams].sort((a, b) => a.TeamNum - b.TeamNum).map((team) => ({ ...team })) : [];
	}

	/**
	 * Live results of every player seen in the current match, sorted by score: the same shape as
	 * `MatchSummary.playerResults`, with the latest scoreboard and the tracked stats together.
	 * Can be called at any time, for example on every `UpdateState`.
	 *
	 * While the match is running, `mvp` marks the provisional MVP (best player of the leading team,
	 * or of everyone on a tie) and `leftEarly` marks players who are not in the match right now.
	 * After `MatchEnded`, it gives the final results.
	 */
	getPlayerResults(): MatchPlayerResult[] {
		const teams = this.getTeams();
		const [blue, orange] = teams;
		const leader = blue && orange && blue.Score !== orange.Score ? (blue.Score > orange.Score ? blue : orange).TeamNum : undefined;
		return this.#playerResults(this.#ended ? this.#winnerTeamNum : leader, this.getStats(), teams);
	}

	/**
	 * Live results of each team in the current match, ordered by `TeamNum`: the same shape as
	 * `MatchSummary.teamResults`. `won` is set only after `MatchEnded`.
	 */
	getTeamResults(): MatchTeamResult[] {
		const teams = this.getTeams();
		const stats = this.getStats();
		return this.#teamResults(teams, stats, this.#playerResults(this.#ended ? this.#winnerTeamNum : undefined, stats, teams));
	}

	/** Called with the final stats when a match ends. Returns a function that removes the listener. */
	onMatchEnd(listener: MatchEndListener): Unsubscribe {
		this.#matchEndListeners.add(listener);
		return () => this.#matchEndListeners.delete(listener);
	}

	/**
	 * Called when a match starts: on `MatchInitialized`, not while the players are still in the lobby after
	 * `MatchCreated`. When joining mid-match, on the first `UpdateState` (see {@link matchStarted}).
	 * Returns a function that removes the listener.
	 */
	onMatchStart(listener: MatchStartListener): Unsubscribe {
		this.#matchStartListeners.add(listener);
		return () => this.#matchStartListeners.delete(listener);
	}

	#begin(): void {
		if (this.#started || this.#ended) return;
		this.#started = true;
		for (const listener of [...this.#matchStartListeners]) listener();
	}

	/** Clears every stat, as if a new match had started. */
	reset(): void {
		this.#roundActive = false;
		this.#sawRoundStart = false;
		this.#paused = false;
		this.#ended = false;
		this.#started = false;
		this.#inLobby = false;
		this.#crossbarArmed = true;
		this.#winnerTeamNum = undefined;
		this.#lastClock = undefined;
		this.#lastGame = undefined;
		this.#lastPlayers = [];
		this.#matchGuid = undefined;
		this.#liveTicks = 0;
		this.#secondsPlayed = 0;
		this.#possessionTicks = { blue: 0, orange: 0 };
		this.#players.clear();
		this.#timeline = [];
	}

	/** Events of the current match so far (except `UpdateState`), with the moment each one arrived. */
	getTimeline(): TimelineEntry[] {
		return [...this.#timeline];
	}

	/** The current moment of the match. */
	getMoment(): MatchMoment {
		return this.#moment(this.#lastGame);
	}

	#moment(game: Game | undefined): MatchMoment {
		const timeSeconds = game?.TimeSeconds ?? 0;
		const overtime = game?.bOvertime ?? false;
		return {
			sequence: this.#sequence,
			timeSeconds,
			overtime,
			clock: formatMatchClock(timeSeconds, overtime),
			secondsPlayed: this.#secondsPlayed,
			date: new Date(),
		};
	}

	/** Feeds one event. Called automatically for the attached client. */
	handle(event: StatsApiEvent): void {
		this.#sequence++;
		// A new match clears the timeline, so it is recorded after the reset.
		const startsMatch = event.Event === 'MatchCreated' || event.Event === 'MatchInitialized';
		if (!startsMatch) this.#record(event);

		switch (event.Event) {
			case 'MatchCreated':
				this.reset();
				this.#inLobby = true;
				break;
			case 'MatchInitialized':
				this.reset();
				this.#begin();
				break;
			case 'RoundStarted':
				this.#begin(); // in case MatchInitialized was missed
				this.#roundActive = true;
				this.#sawRoundStart = true;
				this.#crossbarArmed = true;
				break;
			case 'BallHit':
				this.#crossbarArmed = true;
				break;
			case 'CountdownBegin':
			case 'GoalScored':
				this.#roundActive = false;
				break;
			case 'MatchPaused':
				this.#paused = true;
				break;
			case 'MatchUnpaused':
				this.#paused = false;
				break;
			case 'CrossbarHit':
				// The game can send several CrossbarHit for one impact (the ball rolling on the bar, post then bar):
				// only the first one after each touch counts.
				if (this.#counting() && this.#crossbarArmed) {
					this.#crossbarArmed = false;
					this.#crossbarHit(event.Data.BallLastTouch.Player, event.Data.BallLocation.Y);
				}
				break;
			case 'UpdateState':
				if (!this.#ended) this.#tick(event.Data.Game, event.Data.Players, event.Data.MatchGuid);
				break;
			case 'MatchEnded':
				if (!this.#ended) this.#end(event.Data.WinnerTeamNum);
				break;
		}

		if (startsMatch) this.#record(event);
	}

	#record(event: StatsApiEvent): void {
		if (event.Event === 'UpdateState' || this.#ended) return;
		// The union of events and the union of entries line up one to one; TypeScript can't see that.
		this.#timeline.push({ event, moment: this.#moment(this.#lastGame) } as TimelineEntry);
	}

	/** `false` while paused, during goal replays and after the match ended. */
	#counting(): boolean {
		return !this.#paused && !this.#ended && !this.#lastGame?.bReplay;
	}

	#accumulator(player: IdentifiablePlayer): PlayerAccumulator {
		const key = this.#identify(player);
		let entry = this.#players.get(key);
		if (!entry) {
			entry = {
				key,
				PrimaryId: player.PrimaryId ?? '',
				bot: isBot(player),
				Name: player.Name,
				Shortcut: player.Shortcut,
				TeamNum: player.TeamNum,
				boostUsed: 0,
				airTicks: 0,
				wallTicks: 0,
				speedSum: 0,
				speedTicks: 0,
				crossbar: { attack: 0, defense: 0, total: 0 },
				lastBoost: undefined,
				lastSeen: undefined,
				lastSeenAt: undefined,
				sessions: [],
			};
			this.#players.set(key, entry);
		}
		entry.TeamNum = player.TeamNum;
		entry.Name = player.Name; // keep the latest name
		if (player.PrimaryId) {
			entry.PrimaryId = player.PrimaryId;
			entry.bot = isBot(player);
		}
		return entry;
	}

	#crossbarHit(ref: PlayerRef, ballY: number): void {
		// Events only carry a PlayerRef: find the full player to get the same key as in UpdateState.
		const same = (p: PlayerRef) => p.Name === ref.Name && p.Shortcut === ref.Shortcut && p.TeamNum === ref.TeamNum;
		const player = this.#lastPlayers.find(same) ?? [...this.#players.values()].find((entry) => entry.lastSeen && same(entry.lastSeen))?.lastSeen ?? ref;
		const entry = this.#accumulator(player);
		// The blue goal is on the negative Y side.
		const goalTeam = ballY < 0 ? 0 : 1;
		if (goalTeam === ref.TeamNum) entry.crossbar.defense++;
		else entry.crossbar.attack++;
		entry.crossbar.total++;
	}

	#tick(game: Game, players: Player[], matchGuid: string | undefined): void {
		// Without MatchCreated first, this is not a lobby: the tracker joined a match already being played.
		if (!this.#inLobby) this.#begin();
		this.#lastGame = game;
		this.#lastPlayers = players;
		this.#matchGuid = matchGuid ?? this.#matchGuid;

		// Remember every player's latest scoreboard, so it survives if they leave.
		const entries = players.map((player) => [player, this.#accumulator(player)] as const);
		const seenAt = this.#moment(game);
		this.#trackSessions(entries, seenAt);
		for (const [player, entry] of entries) {
			entry.lastSeen = player;
			entry.lastSeenAt = seenAt;
		}
		if (!game.bReplay) this.#count(game, entries); // goal replays repeat old ticks
		seenAt.secondsPlayed = this.#secondsPlayed; // including this tick
	}

	/** Opens a session for players who joined or changed team, and closes it for players who are gone. */
	#trackSessions(entries: ReadonlyArray<readonly [Player, PlayerAccumulator]>, seenAt: MatchMoment): void {
		const present = new Set<PlayerAccumulator>();
		for (const [player, entry] of entries) {
			present.add(entry);
			const open = entry.sessions.at(-1);
			if (open && !open.leftAt && open.TeamNum === player.TeamNum) continue;
			if (open && !open.leftAt) {
				// Changed team: the old session ends now, the new one starts now.
				open.leftAt = seenAt;
				open.switchedTeam = true;
			}
			entry.sessions.push({ TeamNum: player.TeamNum, joinedAt: seenAt, switchedTeam: false });
		}
		for (const entry of this.#players.values()) {
			const open = entry.sessions.at(-1);
			if (!present.has(entry) && open && !open.leftAt && entry.lastSeenAt) open.leftAt = entry.lastSeenAt;
		}
	}

	#count(game: Game, entries: ReadonlyArray<readonly [Player, PlayerAccumulator]>): void {
		const clockStep = this.#lastClock === undefined ? 0 : Math.abs(game.TimeSeconds - this.#lastClock);
		this.#lastClock = game.TimeSeconds;

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
		for (const [player, entry] of entries) {
			if (isInAir(player)) entry.airTicks++;
			else if (isOnWall(player)) entry.wallTicks++;
			if (hasSpeed(player)) {
				entry.speedSum += player.Speed;
				entry.speedTicks++;
			}
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

		const players: TrackedPlayerStats[] = [...this.#players.values()].map((entry) => ({
			key: entry.key,
			PrimaryId: entry.PrimaryId,
			bot: entry.bot,
			Name: entry.Name,
			Shortcut: entry.Shortcut,
			TeamNum: entry.TeamNum,
			boostUsed: entry.boostUsed,
			airTime: seconds(entry.airTicks),
			onWallTime: seconds(entry.wallTicks),
			averageSpeed: entry.speedTicks > 0 ? entry.speedSum / entry.speedTicks : 0,
			drivingTime: seconds(entry.speedTicks),
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
			boost: {
				players: players.map(({ key, PrimaryId, bot, Name, Shortcut, TeamNum, boostUsed }) => ({
					key,
					PrimaryId,
					bot,
					Name,
					Shortcut,
					TeamNum,
					boostUsed,
				})),
				teams: boostTeams,
			},
			players,
		};
	}

	#end(winnerTeamNum: TeamNum): void {
		this.#ended = true;
		this.#winnerTeamNum = winnerTeamNum;
		this.#roundActive = false;
		const game = this.#lastGame;
		const teams = this.getTeams();
		const scoreboard = [...this.#lastPlayers];
		const stats = this.getStats();
		const playerResults = this.#playerResults(winnerTeamNum, stats, teams);

		const summary: MatchSummary = {
			...stats,
			matchGuid: this.#matchGuid,
			arena: game?.Arena,
			teams,
			winnerTeamNum,
			overtime: game?.bOvertime ?? false,
			scoreboard,
			playerResults,
			teamResults: this.#teamResults(teams, stats, playerResults),
			mvp: playerResults.find((player) => player.mvp),
			endedAt: new Date(),
			endMoment: this.#timeline.at(-1)?.moment ?? this.getMoment(),
			goals: this.#timeline.flatMap((entry) =>
				entry.event.Event === 'GoalScored' ? [{ moment: entry.moment, data: entry.event.Data }] : [],
			),
			timeline: [...this.#timeline],
		};
		for (const listener of [...this.#matchEndListeners]) listener(summary);
	}

	#teamResults(teams: GameTeam[], stats: MatchStats, playerResults: readonly MatchPlayerResult[]): MatchTeamResult[] {
		const winner = this.#ended ? this.#winnerTeamNum : undefined;
		return teams.map((team) => {
			const side = teamSide(team.TeamNum);
			const members = playerResults.filter((player) => player.TeamNum === team.TeamNum);
			const shots = members.reduce((sum, player) => sum + player.Shots, 0);
			const playerGoals = members.reduce((sum, player) => sum + player.Goals, 0);
			const boostUsed = side ? stats.boost.teams[side] : 0;
			return {
				TeamNum: team.TeamNum,
				name: teamName(teams, team.TeamNum),
				goals: team.Score,
				shots,
				shootingPercent: percentOf(playerGoals, shots),
				...(winner !== undefined ? { won: team.TeamNum === winner } : {}),
				boostUsed,
				boostPerMinute: perMinute(boostUsed, stats.secondsPlayed),
				possessionPercent: side ? stats.possession.percent[side] : 0,
			};
		});
	}

	/** Scoreboard of the last `UpdateState` plus the players who left, merged with the tracked stats. */
	#playerResults(winnerTeamNum: TeamNum | undefined, stats: MatchStats, teams: GameTeam[]): MatchPlayerResult[] {
		const scoreboard = this.#lastPlayers;
		const tracked = new Map(stats.players.map((player) => [player.key, player]));
		const mvpKey = (() => {
			const mvp = getMvp(scoreboard, winnerTeamNum);
			return mvp ? this.#identify(mvp) : undefined;
		})();

		// Players who left before the end keep their last known scoreboard (anti rage quit).
		const present = new Set(scoreboard.map((player) => this.#identify(player)));
		const left = [...this.#players.values()].flatMap((entry) =>
			entry.lastSeen && !present.has(entry.key) ? [{ player: entry.lastSeen, leftEarly: true, leftAt: entry.lastSeenAt }] : [],
		);
		const everyone = [...scoreboard.map((player) => ({ player, leftEarly: false, leftAt: undefined })), ...left];

		return everyone
			.map(({ player, leftEarly, leftAt }) => {
				const key = this.#identify(player);
				const own = tracked.get(key);
				const sessions = (this.#players.get(key)?.sessions ?? []).map(
					(session): PlayerSession => ({
						TeamNum: session.TeamNum,
						team: teamName(teams, session.TeamNum),
						joinedAt: { ...session.joinedAt },
						...(session.leftAt ? { leftAt: { ...session.leftAt } } : {}),
						switchedTeam: session.switchedTeam,
					}),
				);
				// An open session lasts until now (or the end of the match).
				const secondsPlayed = sessions.reduce(
					(sum, session) => sum + Math.max(0, (session.leftAt?.secondsPlayed ?? stats.secondsPlayed) - session.joinedAt.secondsPlayed),
					0,
				);
				const result: MatchPlayerResult = {
					key,
					PrimaryId: player.PrimaryId,
					bot: isBot(player),
					Name: player.Name,
					Shortcut: player.Shortcut,
					TeamNum: player.TeamNum,
					team: teamName(teams, player.TeamNum),
					mvp: key === mvpKey,
					leftEarly,
					...(leftAt ? { leftAt: { ...leftAt } } : {}),
					sessions,
					joins: sessions.filter((session, i) => i === 0 || !sessions[i - 1]!.switchedTeam).length,
					leaves: sessions.filter((session) => session.leftAt && !session.switchedTeam).length,
					...(this.#ended && winnerTeamNum !== undefined ? { won: player.TeamNum === winnerTeamNum } : {}),
					secondsPlayed,
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
					averageSpeed: own?.averageSpeed ?? 0,
					drivingTime: own?.drivingTime ?? 0,
					crossbar: own ? { ...own.crossbar } : { attack: 0, defense: 0, total: 0 },
					shootingPercent: 0,
					goalParticipation: 0,
					boostPerMinute: perMinute(own?.boostUsed ?? 0, secondsPlayed),
				};
				for (const stat of TOTAL_STATS) result[stat] = player[stat] ?? 0;
				const teamGoals = teams.find((team) => team.TeamNum === player.TeamNum)?.Score ?? 0;
				result.shootingPercent = percentOf(result.Goals, result.Shots);
				result.goalParticipation = percentOf(result.Goals + result.Assists, teamGoals);
				return result;
			})
			.sort((a, b) => b.Score - a.Score);
	}
}
