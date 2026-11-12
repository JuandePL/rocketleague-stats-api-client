import type { BallLastTouch, Game, GameBall, GameTeam, Player, PlayerRef, Vector } from '../types/common.js';
import {
	EVENT_NAMES,
	type BallHitData,
	type BaseEventData,
	type BoostPickupData,
	type ClockUpdatedSecondsData,
	type CrossbarHitData,
	type EventDataMap,
	type EventName,
	type GoalScoredData,
	type MatchEndedData,
	type PlayerJoinedData,
	type PlayerLeftData,
	type RawEventEnvelope,
	type ReplayCreatedData,
	type StatfeedEventData,
	type StatsApiEvent,
	type StatsApiEventOf,
	type UpdateStateData,
} from '../types/events.js';
import { arrayOf, isBoolean, isNumber, isRecord, isString, oneOf, optional, shape, type Guard } from './primitives.js';

// ---------------------------------------------------------------------------
// Shared structures
// ---------------------------------------------------------------------------

export const isVector: Guard<Vector> = shape<Vector>({ X: isNumber, Y: isNumber, Z: isNumber });

export const isPlayerRef: Guard<PlayerRef> = shape<PlayerRef>({
	Name: isString,
	Shortcut: isNumber,
	TeamNum: isNumber,
});

export const isBallLastTouch: Guard<BallLastTouch> = shape<BallLastTouch>({
	Player: isPlayerRef,
	Speed: isNumber,
});

export const isPlayer: Guard<Player> = shape<Player>({
	Name: isString,
	Shortcut: isNumber,
	TeamNum: isNumber,
	PrimaryId: isString,
	Score: isNumber,
	Goals: isNumber,
	Shots: isNumber,
	Assists: isNumber,
	Saves: isNumber,
	Touches: isNumber,
	CarTouches: isNumber,
	Demos: isNumber,
	Loadout: optional(arrayOf(isString)),
	bHasCar: optional(isBoolean),
	Speed: optional(isNumber),
	Boost: optional(isNumber),
	bBoosting: optional(isBoolean),
	bOnGround: optional(isBoolean),
	bOnWall: optional(isBoolean),
	bPowersliding: optional(isBoolean),
	bDemolished: optional(isBoolean),
	bSupersonic: optional(isBoolean),
	PickupClass: optional(isString),
	Attacker: optional(isPlayerRef),
});

export const isGameTeam: Guard<GameTeam> = shape<GameTeam>({
	Name: isString,
	TeamNum: isNumber,
	Score: isNumber,
	ColorPrimary: isString,
	ColorSecondary: isString,
});

export const isGameBall: Guard<GameBall> = shape<GameBall>({ Speed: isNumber, TeamNum: isNumber });

export const isGame: Guard<Game> = shape<Game>({
	Teams: arrayOf(isGameTeam),
	PlaylistId: optional(isNumber),
	TimeSeconds: isNumber,
	bOvertime: isBoolean,
	Ball: isGameBall,
	bReplay: isBoolean,
	bHasWinner: isBoolean,
	Winner: isString,
	Arena: isString,
	bHasTarget: isBoolean,
	Target: optional(isPlayerRef),
	Frame: optional(isNumber),
	Elapsed: optional(isNumber),
});

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

const matchGuid = optional(isString);

/** Guard for events whose payload only carries `MatchGuid`. */
const isBaseEventData: Guard<BaseEventData> = shape<BaseEventData>({ MatchGuid: matchGuid });

export const isUpdateStateData: Guard<UpdateStateData> = shape<UpdateStateData>({
	MatchGuid: matchGuid,
	Players: arrayOf(isPlayer),
	Game: isGame,
});

export const isBallHitData: Guard<BallHitData> = shape<BallHitData>({
	MatchGuid: matchGuid,
	Players: arrayOf(isPlayerRef),
	Ball: shape<BallHitData['Ball']>({
		PreHitSpeed: isNumber,
		PostHitSpeed: isNumber,
		Location: isVector,
	}),
});

export const isBoostPickupData: Guard<BoostPickupData> = shape<BoostPickupData>({
	MatchGuid: matchGuid,
	Player: isPlayerRef,
	Location: isVector,
	BoostAmount: isNumber,
	BoostType: oneOf(['BoostType_Pad', 'BoostType_Pill']),
	bReplay: isBoolean,
});

export const isClockUpdatedSecondsData: Guard<ClockUpdatedSecondsData> = shape<ClockUpdatedSecondsData>({
	MatchGuid: matchGuid,
	TimeSeconds: isNumber,
	bOvertime: isBoolean,
});

export const isCrossbarHitData: Guard<CrossbarHitData> = shape<CrossbarHitData>({
	MatchGuid: matchGuid,
	BallLocation: isVector,
	BallSpeed: isNumber,
	ImpactForce: isNumber,
	BallLastTouch: isBallLastTouch,
});

export const isGoalScoredData: Guard<GoalScoredData> = shape<GoalScoredData>({
	MatchGuid: matchGuid,
	GoalSpeed: isNumber,
	GoalTime: isNumber,
	ImpactLocation: isVector,
	Scorer: isPlayerRef,
	Assister: optional(isPlayerRef),
	BallLastTouch: isBallLastTouch,
});

export const isMatchEndedData: Guard<MatchEndedData> = shape<MatchEndedData>({
	MatchGuid: matchGuid,
	WinnerTeamNum: isNumber,
});

export const isPlayerJoinedData: Guard<PlayerJoinedData> = shape<PlayerJoinedData>({
	MatchGuid: matchGuid,
	PlayerName: isString,
	PrimaryId: isString,
});

export const isPlayerLeftData: Guard<PlayerLeftData> = shape<PlayerLeftData>({
	MatchGuid: matchGuid,
	PlayerName: isString,
	PrimaryId: isString,
});

export const isReplayCreatedData: Guard<ReplayCreatedData> = shape<ReplayCreatedData>({
	MatchGuid: matchGuid,
	FileName: isString,
	Date: isString,
});

export const isStatfeedEventData: Guard<StatfeedEventData> = shape<StatfeedEventData>({
	MatchGuid: matchGuid,
	EventName: isString,
	Type: isString,
	MainTarget: isPlayerRef,
	SecondaryTarget: optional(isPlayerRef),
});

export const isCountdownBeginData: Guard<EventDataMap['CountdownBegin']> = isBaseEventData;
export const isGoalReplayEndData: Guard<EventDataMap['GoalReplayEnd']> = isBaseEventData;
export const isGoalReplayStartData: Guard<EventDataMap['GoalReplayStart']> = isBaseEventData;
export const isGoalReplayWillEndData: Guard<EventDataMap['GoalReplayWillEnd']> = isBaseEventData;
export const isMatchCreatedData: Guard<EventDataMap['MatchCreated']> = isBaseEventData;
export const isMatchDestroyedData: Guard<EventDataMap['MatchDestroyed']> = isBaseEventData;
export const isMatchInitializedData: Guard<EventDataMap['MatchInitialized']> = isBaseEventData;
export const isMatchPausedData: Guard<EventDataMap['MatchPaused']> = isBaseEventData;
export const isMatchUnpausedData: Guard<EventDataMap['MatchUnpaused']> = isBaseEventData;
export const isPodiumStartData: Guard<EventDataMap['PodiumStart']> = isBaseEventData;
export const isRoundStartedData: Guard<EventDataMap['RoundStarted']> = isBaseEventData;

/** Payload guard for every event, keyed by event name. */
export const eventDataGuards: { readonly [E in EventName]: Guard<EventDataMap[E]> } = {
	UpdateState: isUpdateStateData,
	BallHit: isBallHitData,
	BoostPickup: isBoostPickupData,
	ClockUpdatedSeconds: isClockUpdatedSecondsData,
	CountdownBegin: isCountdownBeginData,
	CrossbarHit: isCrossbarHitData,
	GoalReplayEnd: isGoalReplayEndData,
	GoalReplayStart: isGoalReplayStartData,
	GoalReplayWillEnd: isGoalReplayWillEndData,
	GoalScored: isGoalScoredData,
	MatchCreated: isMatchCreatedData,
	MatchDestroyed: isMatchDestroyedData,
	MatchEnded: isMatchEndedData,
	MatchInitialized: isMatchInitializedData,
	MatchPaused: isMatchPausedData,
	MatchUnpaused: isMatchUnpausedData,
	PlayerJoined: isPlayerJoinedData,
	PlayerLeft: isPlayerLeftData,
	PodiumStart: isPodiumStartData,
	ReplayCreated: isReplayCreatedData,
	RoundStarted: isRoundStartedData,
	StatfeedEvent: isStatfeedEventData,
};

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

/** Checks that a string is a known event name. */
export const isEventName: Guard<EventName> = oneOf(EVENT_NAMES);

/** Checks that `data` is a valid payload for the event `name`. */
export function isEventData<E extends EventName>(name: E, data: unknown): data is EventDataMap[E] {
	const guard: Guard<EventDataMap[E]> = eventDataGuards[name];
	return guard(data);
}

/** Checks the raw envelope shape (`Event` string + `Data` string or object), without validating the payload. */
export function isRawEventEnvelope(value: unknown): value is RawEventEnvelope {
	return isRecord(value) && isString(value.Event) && (isString(value.Data) || isRecord(value.Data));
}

/**
 * Checks that a value is a fully valid, decoded event message (with `Data` already parsed),
 * optionally restricted to a single event name.
 *
 * ```ts
 * if (isStatsApiEvent(msg, 'GoalScored')) msg.Data.Scorer.Name;
 * ```
 */
export function isStatsApiEvent(value: unknown): value is StatsApiEvent;
export function isStatsApiEvent<E extends EventName>(value: unknown, name: E): value is StatsApiEventOf<E>;
export function isStatsApiEvent(value: unknown, name?: EventName): boolean {
	if (!isRecord(value) || !isEventName(value.Event)) return false;
	if (name !== undefined && value.Event !== name) return false;
	return isEventData(value.Event, value.Data);
}
