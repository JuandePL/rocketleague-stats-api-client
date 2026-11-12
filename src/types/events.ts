import type { BallLastTouch, Game, Player, PlayerRef, PrimaryId, TeamNum, Vector } from './common.js';

/** Every event name the Stats API can emit. */
export const EVENT_NAMES = [
	'UpdateState',
	'BallHit',
	'BoostPickup',
	'ClockUpdatedSeconds',
	'CountdownBegin',
	'CrossbarHit',
	'GoalReplayEnd',
	'GoalReplayStart',
	'GoalReplayWillEnd',
	'GoalScored',
	'MatchCreated',
	'MatchDestroyed',
	'MatchEnded',
	'MatchInitialized',
	'MatchPaused',
	'MatchUnpaused',
	'PlayerJoined',
	'PlayerLeft',
	'PodiumStart',
	'ReplayCreated',
	'RoundStarted',
	'StatfeedEvent',
] as const;

/** Union of every event name the Stats API can emit. */
export type EventName = (typeof EVENT_NAMES)[number];

/** Fields present in every event payload. */
export interface BaseEventData {
	/** Match identifier. Only set for online or LAN matches. */
	MatchGuid?: string;
}

/** Sent X times per second, based on the player's `PacketSendRate` setting. */
export interface UpdateStateData extends BaseEventData {
	/** One entry per player in the match. */
	Players: Player[];
	/** Match metadata. */
	Game: Game;
}

/** Sent one frame after the ball is hit. */
export interface BallHitData extends BaseEventData {
	/** Players that hit the ball that frame. */
	Players: PlayerRef[];
	/** Ball state at the moment of the hit. */
	Ball: {
		/** Ball speed before the hit (Unreal Units/second). */
		PreHitSpeed: number;
		/** Ball speed after the hit (Unreal Units/second). */
		PostHitSpeed: number;
		/** World position of the ball at impact. */
		Location: Vector;
	};
}

/** Known boost pickup classes. */
export type BoostType = 'BoostType_Pad' | 'BoostType_Pill';

/** `SPECTATOR` Sent when a vehicle collects a boost pad or pill. */
export interface BoostPickupData extends BaseEventData {
	/** The player who collected the boost. */
	Player: PlayerRef;
	/** World location of the pickup. */
	Location: Vector;
	/** Amount of boost granted by the pickup. */
	BoostAmount: number;
	/** Pickup class: `BoostType_Pad` (small pad), `BoostType_Pill` (full/big boost). */
	BoostType: BoostType;
	/** True if the pickup occurred during replay playback. */
	bReplay: boolean;
}

/** Sent when the in-game clock has changed. */
export interface ClockUpdatedSecondsData extends BaseEventData {
	/** Seconds remaining in the match. */
	TimeSeconds: number;
	/** True if the game is in overtime. */
	bOvertime: boolean;
}

/** Sent at the start of each round when the countdown starts. */
export interface CountdownBeginData extends BaseEventData {}

/** Sent when the ball hits a crossbar. */
export interface CrossbarHitData extends BaseEventData {
	/** World position of the ball when the impact occurred. */
	BallLocation: Vector;
	/** Ball speed on impact. */
	BallSpeed: number;
	/** Impact force of the ball relative to the crossbar normal. */
	ImpactForce: number;
	/** The last touch of the ball before the crossbar hit. */
	BallLastTouch: BallLastTouch;
}

/** Sent when a goal replay ends. */
export interface GoalReplayEndData extends BaseEventData {}

/** Sent when a goal replay starts. */
export interface GoalReplayStartData extends BaseEventData {}

/** Sent when the ball explodes during a goal replay. Does not fire if the replay is skipped. */
export interface GoalReplayWillEndData extends BaseEventData {}

/** Sent when a goal is scored. */
export interface GoalScoredData extends BaseEventData {
	/** Speed of the ball (Unreal Units/second) when it crossed the goal line. */
	GoalSpeed: number;
	/** Length of the previous round in seconds (not the match clock). */
	GoalTime: number;
	/** World position of the ball when the goal was scored. */
	ImpactLocation: Vector;
	/** The player who scored the goal. */
	Scorer: PlayerRef;
	/** `CONDITIONAL` Present only when an assist was recorded. */
	Assister?: PlayerRef;
	/** The last touch of the ball before the goal. */
	BallLastTouch: BallLastTouch;
}

/** Sent when all teams are created and replicated. */
export interface MatchCreatedData extends BaseEventData {}

/** Sent when leaving the game. */
export interface MatchDestroyedData extends BaseEventData {}

/** Sent when the match ends and a winner is chosen. */
export interface MatchEndedData extends BaseEventData {
	/** Team index of the winning team. */
	WinnerTeamNum: TeamNum;
}

/** Sent when the first countdown starts. */
export interface MatchInitializedData extends BaseEventData {}

/** Sent when the game is paused by a match admin. */
export interface MatchPausedData extends BaseEventData {}

/** Sent when the game is unpaused by a match admin. */
export interface MatchUnpausedData extends BaseEventData {}

/** Sent when a player is added to the current match. */
export interface PlayerJoinedData extends BaseEventData {
	/** Display name of the player who joined. */
	PlayerName: string;
	/** Platform identifier in the format `Platform|Uid|Splitscreen`. */
	PrimaryId: PrimaryId;
}

/** Sent when a player is removed from the current match. */
export interface PlayerLeftData extends BaseEventData {
	/** Display name of the player who left. */
	PlayerName: string;
	/** Platform identifier in the format `Platform|Uid|Splitscreen`. */
	PrimaryId: PrimaryId;
}

/** Sent when the game enters the podium state after the match ends. */
export interface PodiumStartData extends BaseEventData {}

/**
 * Sent when a replay is initialized. Does not pertain to goal replays,
 * only replays loaded via the Match History menu.
 */
export interface ReplayCreatedData extends BaseEventData {
	/** File name of the replay. */
	FileName: string;
	/** Timestamp the replay was created (e.g. `"2026-06-05 18:42:13"`). */
	Date: string;
}

/** Sent when the game enters the active state (after the countdown finishes). */
export interface RoundStartedData extends BaseEventData {}

/**
 * Known `StatfeedEvent.EventName` values. The type stays open (`string & {}`)
 * so new stats added by the game don't break consumers.
 */
export type StatEventName =
	| 'Demolish'
	| 'Demolition'
	| 'Goal'
	| 'Win'
	| 'MVP'
	| 'AerialGoal'
	| 'BackwardsGoal'
	| 'BicycleGoal'
	| 'LongGoal'
	| 'TurtleGoal'
	| 'PoolShot'
	| 'OvertimeGoal'
	| 'HatTrick'
	| 'Assist'
	| 'Playmaker'
	| 'Save'
	| 'EpicSave'
	| 'Savior'
	| 'Shot'
	| 'Center'
	| 'Clear'
	| 'FirstTouch'
	| 'BreakoutDamage'
	| 'BreakoutDamageLarge'
	| 'LowFive'
	| 'HighFive'
	| 'HoopsSwishGoal'
	| 'BicycleHit'
	| 'OwnGoal'
	| 'FlipReset'
	| (string & {});

/** Sent when someone earns a stat. */
export interface StatfeedEventData extends BaseEventData {
	/** Asset name of the StatEvent (e.g. `"Demolish"`, `"Save"`). Prefer this over `Type` for logic. */
	EventName: StatEventName;
	/** Localized display label for the stat (e.g. `"Demolition"`). */
	Type: string;
	/** Player who earned the stat. */
	MainTarget: PlayerRef;
	/** `CONDITIONAL` Player involved in the stat (e.g. the demolished player). */
	SecondaryTarget?: PlayerRef;
}

/** Maps every event name to its payload type. */
export interface EventDataMap {
	UpdateState: UpdateStateData;
	BallHit: BallHitData;
	BoostPickup: BoostPickupData;
	ClockUpdatedSeconds: ClockUpdatedSecondsData;
	CountdownBegin: CountdownBeginData;
	CrossbarHit: CrossbarHitData;
	GoalReplayEnd: GoalReplayEndData;
	GoalReplayStart: GoalReplayStartData;
	GoalReplayWillEnd: GoalReplayWillEndData;
	GoalScored: GoalScoredData;
	MatchCreated: MatchCreatedData;
	MatchDestroyed: MatchDestroyedData;
	MatchEnded: MatchEndedData;
	MatchInitialized: MatchInitializedData;
	MatchPaused: MatchPausedData;
	MatchUnpaused: MatchUnpausedData;
	PlayerJoined: PlayerJoinedData;
	PlayerLeft: PlayerLeftData;
	PodiumStart: PodiumStartData;
	ReplayCreated: ReplayCreatedData;
	RoundStarted: RoundStartedData;
	StatfeedEvent: StatfeedEventData;
}

/** A decoded event message with its name and typed payload. */
export interface StatsApiEventOf<E extends EventName> {
	Event: E;
	Data: EventDataMap[E];
}

/**
 * Discriminated union of every decoded event message.
 * Narrow it by checking `event.Event`:
 *
 * ```ts
 * if (event.Event === 'GoalScored') event.Data.Scorer.Name;
 * ```
 */
export type StatsApiEvent = { [E in EventName]: StatsApiEventOf<E> }[EventName];

/**
 * The raw envelope as it arrives over the socket. The game encodes `Data`
 * as a JSON string; some tools forward it as an object, so both are accepted.
 */
export interface RawEventEnvelope {
	Event: string;
	Data: string | Record<string, unknown>;
}
