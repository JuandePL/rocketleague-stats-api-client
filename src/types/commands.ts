/** Every command name the Stats API accepts. */
export const COMMAND_NAMES = [
	'ChangePOV',
	'LoadReplay',
	'SeekReplay',
	'SetGameSpeed',
	'SetHUDVisibility',
	'SetMatchPaused',
] as const;

/** Union of every command name the Stats API accepts. */
export type CommandName = (typeof COMMAND_NAMES)[number];

/** Accepted camera perspectives for `ChangePOV`. */
export const PERSPECTIVES = [
	/** Freely move around the map. */
	'Fly',
	/** Follow the position of a player or ball. */
	'SoftAttach',
	/** Follow the position and rotation of a player. */
	'HardAttach',
	/** View from a player's perspective. Applied automatically when Focus targets a player and no Perspective is given. */
	'PlayerView',
	/** Automatically spectates. */
	'AutoCam',
	/** Automatically switches between player views. */
	'Camera_Director',
] as const;

/** Camera mode for `ChangePOV`. */
export type Perspective = (typeof PERSPECTIVES)[number];

/**
 * What to look at for `ChangePOV`: `"Ball"`, or a player's spectator shortcut
 * as an all-digit string (e.g. `"1"`). Any other value is rejected by the game.
 */
export type Focus = 'Ball' | `${number}`;

/**
 * `SPECTATOR` `REPLAY` Changes the spectator/replay viewpoint.
 * At least one of `Focus` or `Perspective` must be supplied; both may be combined.
 */
export type ChangePOVData =
	| { Focus: Focus; Perspective?: Perspective }
	| { Focus?: Focus; Perspective: Perspective };

/**
 * Loads and begins playback of a replay by file name or by file path.
 * At least one of `FileName` or `Path` must be supplied. `FileName` takes precedence.
 */
export type LoadReplayData =
	| { FileName: string; Path?: string }
	| { FileName?: string; Path: string };

/**
 * `REPLAY` Jumps replay playback to a target frame or time.
 * At least one of `Frame` or `TimeSeconds` must be supplied. `Frame` takes precedence.
 */
export type SeekReplayData =
	| { Frame: number; TimeSeconds?: number }
	| { Frame?: number; TimeSeconds: number };

/** `REPLAY` Sets replay playback speed. */
export interface SetGameSpeedData {
	/** Playback multiplier. 1.0 = normal, 0.5 = half speed, 2.0 = double. Must be ≥ 0. */
	Speed: number;
}

/** Shows or hides the in-game HUD. */
export interface SetHUDVisibilityData {
	/** `true` shows the HUD; `false` hides it. */
	bVisible: boolean;
}

/** Pauses or unpauses the current match or replay. */
export interface SetMatchPausedData {
	/** `true` pauses; `false` resumes. */
	bPaused: boolean;
}

/** Maps every command name to its payload type. */
export interface CommandDataMap {
	ChangePOV: ChangePOVData;
	LoadReplay: LoadReplayData;
	SeekReplay: SeekReplayData;
	SetGameSpeed: SetGameSpeedData;
	SetHUDVisibility: SetHUDVisibilityData;
	SetMatchPaused: SetMatchPausedData;
}

/** A command envelope with its name and typed payload. */
export interface StatsApiCommandOf<C extends CommandName> {
	Command: C;
	Data: CommandDataMap[C];
}

/** Discriminated union of every command envelope. */
export type StatsApiCommand = { [C in CommandName]: StatsApiCommandOf<C> }[CommandName];
