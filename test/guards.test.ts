import { describe, expect, it } from 'vitest';
import {
	EVENT_NAMES,
	isChangePOVData,
	isCommandData,
	isEventData,
	isEventName,
	isGoalScoredData,
	isLoadReplayData,
	isSeekReplayData,
	isSetGameSpeedData,
	isStatsApiCommand,
	isStatsApiEvent,
	isUpdateStateData,
	parseEventMessage,
	shape,
	isString,
	optional,
	type Guard,
} from '../src/index.js';
import { fixtures, wire } from './fixtures.js';

describe('event guards', () => {
	it.each(EVENT_NAMES)('accepts the official %s example', (name) => {
		expect(isEventData(name, fixtures[name])).toBe(true);
		expect(isStatsApiEvent({ Event: name, Data: fixtures[name] }, name)).toBe(true);
	});

	it('accepts payloads without MatchGuid (offline matches)', () => {
		expect(isEventData('RoundStarted', {})).toBe(true);
		const { MatchGuid: _, ...rest } = fixtures.GoalScored;
		expect(isGoalScoredData(rest)).toBe(true);
	});

	it('accepts UpdateState without SPECTATOR / CONDITIONAL fields', () => {
		const p = fixtures.UpdateState.Players[0]!;
		const minimalPlayer = {
			Name: p.Name, PrimaryId: p.PrimaryId, Shortcut: p.Shortcut, TeamNum: p.TeamNum, Score: 0, Goals: 0,
			Shots: 0, Assists: 0, Saves: 0, Touches: 0, CarTouches: 0, Demos: 0,
		};
		const { Target: _t, Frame: _f, Elapsed: _e, PlaylistId: _p, ...game } = fixtures.UpdateState.Game;
		expect(isUpdateStateData({ Players: [minimalPlayer], Game: game })).toBe(true);
	});

	it('allows unknown extra fields', () => {
		expect(isGoalScoredData({ ...fixtures.GoalScored, NewField: 1 })).toBe(true);
	});

	it('rejects wrong types and missing fields', () => {
		expect(isGoalScoredData({ ...fixtures.GoalScored, GoalSpeed: '87' })).toBe(false);
		expect(isGoalScoredData({ ...fixtures.GoalScored, Scorer: undefined })).toBe(false);
		expect(isGoalScoredData({ ...fixtures.GoalScored, Assister: { Name: 'x' } })).toBe(false);
		expect(isEventData('BoostPickup', { ...fixtures.BoostPickup, BoostType: 'Other' })).toBe(false);
		expect(isEventData('MatchEnded', { WinnerTeamNum: Number.NaN })).toBe(false);
		expect(isEventData('UpdateState', { ...fixtures.UpdateState, Players: [{}] })).toBe(false);
		expect(isEventData('RoundStarted', null)).toBe(false);
		expect(isEventData('RoundStarted', [])).toBe(false);
		expect(isEventData('RoundStarted', { MatchGuid: 5 })).toBe(false);
	});

	it('rejects unknown event names', () => {
		expect(isEventName('GoalScored')).toBe(true);
		expect(isEventName('NotAnEvent')).toBe(false);
		expect(isStatsApiEvent({ Event: 'NotAnEvent', Data: {} })).toBe(false);
		expect(isStatsApiEvent({ Event: 'GoalScored', Data: fixtures.GoalScored }, 'BallHit')).toBe(false);
	});
});

describe('command guards', () => {
	it('validates ChangePOV', () => {
		expect(isChangePOVData({ Focus: 'Ball' })).toBe(true);
		expect(isChangePOVData({ Focus: '12', Perspective: 'PlayerView' })).toBe(true);
		expect(isChangePOVData({ Perspective: 'Camera_Director' })).toBe(true);
		expect(isChangePOVData({})).toBe(false);
		expect(isChangePOVData({ Focus: 'PlayerA' })).toBe(false);
		expect(isChangePOVData({ Focus: '1a' })).toBe(false);
		expect(isChangePOVData({ Focus: 1 })).toBe(false);
		expect(isChangePOVData({ Perspective: 'TopDown' })).toBe(false);
	});

	it('validates LoadReplay', () => {
		expect(isLoadReplayData({ FileName: 'Stadium_P_2026-06-05_18-42' })).toBe(true);
		expect(isLoadReplayData({ Path: 'C:/replays/a.replay' })).toBe(true);
		expect(isLoadReplayData({ FileName: '', Path: 'C:/a.replay' })).toBe(true);
		expect(isLoadReplayData({})).toBe(false);
		expect(isLoadReplayData({ FileName: '' })).toBe(false);
		expect(isLoadReplayData({ FileName: 5 })).toBe(false);
	});

	it('validates SeekReplay', () => {
		expect(isSeekReplayData({ TimeSeconds: 120.5 })).toBe(true);
		expect(isSeekReplayData({ Frame: 300 })).toBe(true);
		expect(isSeekReplayData({})).toBe(false);
		expect(isSeekReplayData({ Frame: 1.5 })).toBe(false);
		expect(isSeekReplayData({ TimeSeconds: -1 })).toBe(false);
	});

	it('validates SetGameSpeed, SetHUDVisibility and SetMatchPaused', () => {
		expect(isSetGameSpeedData({ Speed: 0.5 })).toBe(true);
		expect(isSetGameSpeedData({ Speed: 0 })).toBe(true);
		expect(isSetGameSpeedData({ Speed: -1 })).toBe(false);
		expect(isCommandData('SetHUDVisibility', { bVisible: false })).toBe(true);
		expect(isCommandData('SetHUDVisibility', { bVisible: 'false' })).toBe(false);
		expect(isCommandData('SetMatchPaused', { bPaused: true })).toBe(true);
		expect(isCommandData('SetMatchPaused', {})).toBe(false);
	});

	it('validates full command envelopes', () => {
		expect(isStatsApiCommand({ Command: 'SetMatchPaused', Data: { bPaused: true } })).toBe(true);
		expect(isStatsApiCommand({ Command: 'SetMatchPaused', Data: { bPaused: true } }, 'ChangePOV')).toBe(false);
		expect(isStatsApiCommand({ Command: 'Explode', Data: {} })).toBe(false);
	});
});

describe('parseEventMessage', () => {
	it('decodes the double-encoded wire format', () => {
		const result = parseEventMessage(wire('GoalScored', fixtures.GoalScored));
		expect(result.ok).toBe(true);
		if (result.ok && result.event.Event === 'GoalScored') {
			expect(result.event.Data.Scorer.Name).toBe('PlayerA');
		}
	});

	it('accepts Data as an object and pre-parsed envelopes', () => {
		expect(parseEventMessage(JSON.stringify({ Event: 'RoundStarted', Data: {} })).ok).toBe(true);
		expect(parseEventMessage({ Event: 'RoundStarted', Data: '{}' }).ok).toBe(true);
	});

	it('reports each failure reason', () => {
		expect(parseEventMessage('nope')).toMatchObject({ ok: false, reason: 'invalid-json' });
		expect(parseEventMessage('{"Foo":1}')).toMatchObject({ ok: false, reason: 'invalid-envelope' });
		expect(parseEventMessage('{"Event":"RoundStarted","Data":"{bad"}')).toMatchObject({ ok: false, reason: 'invalid-data-json' });
		expect(parseEventMessage('{"Event":"RoundStarted","Data":"5"}')).toMatchObject({ ok: false, reason: 'invalid-data-json' });
		expect(parseEventMessage(wire('Mystery', {}))).toMatchObject({ ok: false, reason: 'unknown-event', event: 'Mystery' });
		expect(parseEventMessage(wire('MatchEnded', {}))).toMatchObject({ ok: false, reason: 'invalid-data', event: 'MatchEnded' });
	});

	it('skips payload validation when validate is false', () => {
		expect(parseEventMessage(wire('MatchEnded', {}), { validate: false }).ok).toBe(true);
	});
});

describe('shape() compile-time checks', () => {
	it('requires a guard for every property', () => {
		interface Sample { a: string; b?: string }
		const ok: Guard<Sample> = shape<Sample>({ a: isString, b: optional(isString) });
		expect(ok({ a: 'x' })).toBe(true);
		// @ts-expect-error -- missing guard for "b"
		shape<Sample>({ a: isString });
	});
});
