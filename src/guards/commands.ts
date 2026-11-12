import {
	COMMAND_NAMES,
	PERSPECTIVES,
	type ChangePOVData,
	type CommandDataMap,
	type CommandName,
	type Focus,
	type LoadReplayData,
	type Perspective,
	type SeekReplayData,
	type SetGameSpeedData,
	type SetHUDVisibilityData,
	type SetMatchPausedData,
	type StatsApiCommand,
	type StatsApiCommandOf,
} from '../types/commands.js';
import { isBoolean, isInteger, isNumber, isRecord, isString, oneOf, optional, type Guard } from './primitives.js';

/** Checks for `"Ball"` or an all-digit spectator shortcut string. */
export const isFocus: Guard<Focus> = (value): value is Focus =>
	value === 'Ball' || (isString(value) && /^\d+$/.test(value));

export const isPerspective: Guard<Perspective> = oneOf(PERSPECTIVES);

/** Checks that a key is present (not `undefined`) and matches `check`. */
function has(record: Record<string, unknown>, key: string, check: (value: unknown) => boolean): boolean {
	return record[key] !== undefined && check(record[key]);
}

export const isChangePOVData: Guard<ChangePOVData> = (value): value is ChangePOVData =>
	isRecord(value) &&
	optional(isFocus)(value.Focus) &&
	optional(isPerspective)(value.Perspective) &&
	(value.Focus !== undefined || value.Perspective !== undefined);

/** `FileName` / `Path` must be strings; at least one must be non-empty. */
export const isLoadReplayData: Guard<LoadReplayData> = (value): value is LoadReplayData =>
	isRecord(value) &&
	optional(isString)(value.FileName) &&
	optional(isString)(value.Path) &&
	(has(value, 'FileName', (v) => v !== '') || has(value, 'Path', (v) => v !== ''));

/** `Frame` must be a non-negative integer, `TimeSeconds` a non-negative number; at least one is required. */
export const isSeekReplayData: Guard<SeekReplayData> = (value): value is SeekReplayData =>
	isRecord(value) &&
	optional((v): v is number => isInteger(v) && v >= 0)(value.Frame) &&
	optional((v): v is number => isNumber(v) && v >= 0)(value.TimeSeconds) &&
	(value.Frame !== undefined || value.TimeSeconds !== undefined);

/** `Speed` must be a finite number ≥ 0. */
export const isSetGameSpeedData: Guard<SetGameSpeedData> = (value): value is SetGameSpeedData =>
	isRecord(value) && isNumber(value.Speed) && value.Speed >= 0;

export const isSetHUDVisibilityData: Guard<SetHUDVisibilityData> = (value): value is SetHUDVisibilityData =>
	isRecord(value) && isBoolean(value.bVisible);

export const isSetMatchPausedData: Guard<SetMatchPausedData> = (value): value is SetMatchPausedData =>
	isRecord(value) && isBoolean(value.bPaused);

/** Payload guard for every command, keyed by command name. */
export const commandDataGuards: { readonly [C in CommandName]: Guard<CommandDataMap[C]> } = {
	ChangePOV: isChangePOVData,
	LoadReplay: isLoadReplayData,
	SeekReplay: isSeekReplayData,
	SetGameSpeed: isSetGameSpeedData,
	SetHUDVisibility: isSetHUDVisibilityData,
	SetMatchPaused: isSetMatchPausedData,
};

/** Checks that a string is a known command name. */
export const isCommandName: Guard<CommandName> = oneOf(COMMAND_NAMES);

/** Checks that `data` is a valid payload for the command `name`. */
export function isCommandData<C extends CommandName>(name: C, data: unknown): data is CommandDataMap[C] {
	const guard: Guard<CommandDataMap[C]> = commandDataGuards[name];
	return guard(data);
}

/**
 * Checks that a value is a fully valid command envelope, optionally restricted to a single command name.
 */
export function isStatsApiCommand(value: unknown): value is StatsApiCommand;
export function isStatsApiCommand<C extends CommandName>(value: unknown, name: C): value is StatsApiCommandOf<C>;
export function isStatsApiCommand(value: unknown, name?: CommandName): boolean {
	if (!isRecord(value) || !isCommandName(value.Command)) return false;
	if (name !== undefined && value.Command !== name) return false;
	return isCommandData(value.Command, value.Data);
}
