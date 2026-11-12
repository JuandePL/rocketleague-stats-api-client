import type { EventDataMap, EventName } from '../src/index.js';

/** Payload examples taken from the official Stats API documentation. */
const guid = { MatchGuid: 'A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6' };
const playerA = { Name: 'PlayerA', Shortcut: 1, TeamNum: 0 };
const playerB = { Name: 'PlayerB', Shortcut: 2, TeamNum: 1 };

export const fixtures: { [E in EventName]: EventDataMap[E] } = {
	UpdateState: {
		...guid,
		Players: [
			{
				...playerA,
				PrimaryId: 'Steam|123|0',
				Score: 125,
				Goals: 1,
				Shots: 2,
				Assists: 0,
				Saves: 1,
				Touches: 14,
				CarTouches: 3,
				Demos: 0,
				Loadout: ['body_grain', 'Skin_bartees', 'Wheel_SoccerBall', 'Boost_AlphaReward', 'None', 'None'],
				bHasCar: true,
				Speed: 1200,
				Boost: 45,
				bBoosting: true,
				bOnGround: true,
				bOnWall: false,
				bPowersliding: false,
				bDemolished: true,
				Attacker: playerB,
				bSupersonic: true,
				PickupClass: 'SpecialPickup_GrapplingHook_TA',
			},
		],
		Game: {
			Teams: [{ Name: 'Blue', TeamNum: 0, Score: 1, ColorPrimary: '0000FF', ColorSecondary: '0000AA' }],
			PlaylistId: 11,
			TimeSeconds: 180,
			bOvertime: false,
			Frame: 120,
			Elapsed: 50.2,
			Ball: { Speed: 850.5, TeamNum: 0 },
			bReplay: false,
			bHasWinner: true,
			Winner: 'Blue',
			Arena: 'Stadium_P',
			bHasTarget: true,
			Target: playerA,
		},
	},
	BallHit: {
		...guid,
		Players: [playerA],
		Ball: { PreHitSpeed: 0, PostHitSpeed: 1450.2, Location: { X: -512, Y: 100, Z: 200 } },
	},
	BoostPickup: {
		...guid,
		Player: playerA,
		Location: { X: -3072, Y: 0, Z: 73 },
		BoostAmount: 100,
		BoostType: 'BoostType_Pill',
		bReplay: false,
	},
	ClockUpdatedSeconds: { ...guid, TimeSeconds: 180, bOvertime: false },
	CountdownBegin: guid,
	CrossbarHit: {
		...guid,
		BallLocation: { X: 120, Y: -2944, Z: 320 },
		BallSpeed: 870.3,
		ImpactForce: 127.5,
		BallLastTouch: { Player: playerA, Speed: 120 },
	},
	GoalReplayEnd: guid,
	GoalReplayStart: guid,
	GoalReplayWillEnd: guid,
	GoalScored: {
		...guid,
		GoalSpeed: 87.3,
		GoalTime: 127.5,
		ImpactLocation: { X: 0, Y: -2944, Z: 320 },
		Scorer: playerA,
		Assister: { Name: 'PlayerC', Shortcut: 3, TeamNum: 0 },
		BallLastTouch: { Player: playerA, Speed: 125 },
	},
	MatchCreated: guid,
	MatchDestroyed: guid,
	MatchEnded: { ...guid, WinnerTeamNum: 0 },
	MatchInitialized: guid,
	MatchPaused: guid,
	MatchUnpaused: guid,
	PlayerJoined: { ...guid, PlayerName: 'PlayerA', PrimaryId: 'Steam|123|0' },
	PlayerLeft: { ...guid, PlayerName: 'PlayerA', PrimaryId: 'Steam|123|0' },
	PodiumStart: guid,
	ReplayCreated: { ...guid, FileName: 'Stadium_P_2026-06-05_18-42', Date: '2026-06-05 18:42:13' },
	RoundStarted: guid,
	StatfeedEvent: {
		...guid,
		EventName: 'Demolish',
		Type: 'Demolition',
		MainTarget: playerA,
		SecondaryTarget: playerB,
	},
};

/** Encodes a message exactly like the game does: `Data` is a JSON string inside the envelope. */
export function wire(event: string, data: unknown): string {
	return JSON.stringify({ Event: event, Data: JSON.stringify(data) });
}
