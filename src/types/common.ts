/**
 * Shared structures used across Stats API events.
 *
 * Field visibility markers used in the docs below (mirroring the official documentation):
 * - `CONDITIONAL`: only present when relevant.
 * - `SPECTATOR`: only sent while spectating.
 * - `REPLAY`: only relevant during replays.
 *
 * @see https://www.rocketleague.com/developer/stats-api
 */

/** Team index. `0` = Blue, `1` = Orange. */
export type TeamNum = number;

/** Well-known team indexes. */
export const Team = {
	Blue: 0,
	Orange: 1,
} as const;

/** Value of `Game.Ball.TeamNum` when the ball has not been touched yet. */
export const BALL_UNTOUCHED_TEAM_NUM = 255;

/** A 3D world position in Unreal Units. */
export interface Vector {
	X: number;
	Y: number;
	Z: number;
}

/** Minimal reference to a player, used by most events. */
export interface PlayerRef {
	/** Display name. */
	Name: string;
	/** Spectator shortcut number. */
	Shortcut: number;
	/** Team index (0 = Blue, 1 = Orange). */
	TeamNum: TeamNum;
}

/** The last touch of the ball before an event (goal, crossbar hit...). */
export interface BallLastTouch {
	/** The player who made the last touch. */
	Player: PlayerRef;
	/** Speed of the ball resulting from this touch. */
	Speed: number;
}

/**
 * Platform identifier in the format `Platform|Uid|Splitscreen`
 * (e.g. `"Steam|123|0"`, `"Epic|456|0"`).
 */
export type PrimaryId = string;

/** Full player state, sent in every `UpdateState` tick. */
export interface Player extends PlayerRef {
	/** Platform identifier in the format `Platform|Uid|Splitscreen`. */
	PrimaryId: PrimaryId;
	/** Total match score. */
	Score: number;
	/** Goals scored this match. */
	Goals: number;
	/** Shot attempts this match. */
	Shots: number;
	/** Assists earned this match. */
	Assists: number;
	/** Saves made this match. */
	Saves: number;
	/** Total ball touches. */
	Touches: number;
	/** Touches by the car body (not ball). */
	CarTouches: number;
	/** Demolitions inflicted. */
	Demos: number;
	/**
	 * Asset names of the equipped loadout for the player's current team, sorted by product slot.
	 * Typed as optional because older game builds did not send it.
	 */
	Loadout?: string[];
	/** `SPECTATOR` True if the player currently has a vehicle. */
	bHasCar?: boolean;
	/** `SPECTATOR` Vehicle speed in Unreal Units/second. */
	Speed?: number;
	/** `SPECTATOR` Boost amount 0–100. */
	Boost?: number;
	/** `SPECTATOR` True if the player is currently boosting. */
	bBoosting?: boolean;
	/** `SPECTATOR` True if at least 3 wheels are touching the world. */
	bOnGround?: boolean;
	/** `SPECTATOR` True if the vehicle is on a wall. */
	bOnWall?: boolean;
	/** `SPECTATOR` True if the player is holding handbrake. */
	bPowersliding?: boolean;
	/** `SPECTATOR` True if the vehicle is currently destroyed. */
	bDemolished?: boolean;
	/** `SPECTATOR` True if the vehicle is at supersonic speed. */
	bSupersonic?: boolean;
	/**
	 * `SPECTATOR` Class name of the player's currently available Rumble pickup
	 * (e.g. `"SpecialPickup_GrapplingHook_TA"`). Omitted when not playing with rumble powerups.
	 */
	PickupClass?: string;
	/** `CONDITIONAL` The player who demolished this player. Present only when demolished. */
	Attacker?: PlayerRef;
}

/** A team entry inside `UpdateState.Game.Teams`. */
export interface GameTeam {
	/** Team name. */
	Name: string;
	/** Team index. */
	TeamNum: TeamNum;
	/** Team goal count. */
	Score: number;
	/** Hex color code (no `#`) for the team's primary color, e.g. `"0000FF"`. */
	ColorPrimary: string;
	/** Hex color code (no `#`) for the team's secondary color. */
	ColorSecondary: string;
}

/** Current ball state inside `UpdateState.Game.Ball`. */
export interface GameBall {
	/** Current ball speed in Unreal Units/second. */
	Speed: number;
	/** Index of the last team to touch the ball. `255` if the ball has not been touched. */
	TeamNum: TeamNum;
}

/** Match metadata, sent in every `UpdateState` tick. */
export interface Game {
	/** One entry per team, ordered by TeamNum. */
	Teams: GameTeam[];
	/**
	 * Playlist Id of the current match.
	 * Typed as optional because older game builds did not send it.
	 */
	PlaylistId?: number;
	/** Seconds remaining in the match. */
	TimeSeconds: number;
	/** True if the match is in overtime. */
	bOvertime: boolean;
	/** Current ball state. */
	Ball: GameBall;
	/** True if a goal replay or history replay is active. */
	bReplay: boolean;
	/** True if a team has won. */
	bHasWinner: boolean;
	/** Name of the winning team. Empty string if no winner yet. */
	Winner: string;
	/** Asset name of the current map (e.g. `"Stadium_P"`). */
	Arena: string;
	/** True if the client is currently viewing a specific vehicle. */
	bHasTarget: boolean;
	/**
	 * `CONDITIONAL` Player currently being viewed. Members are an empty string or `0`
	 * if the player does not have a spectator target.
	 */
	Target?: PlayerRef;
	/** `CONDITIONAL` `REPLAY` Current frame number if a replay is active. */
	Frame?: number;
	/** `CONDITIONAL` `REPLAY` Seconds elapsed since game start if a replay is active. */
	Elapsed?: number;
}
