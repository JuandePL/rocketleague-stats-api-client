import { describe, expect, it, vi } from 'vitest';
import {
	byName,
	byShortcut,
	byStat,
	byTeam,
	RocketLeagueStatsClient,
	sortPlayers,
	type Player,
	type WebSocketLike,
} from '../src/index.js';
import { fixtures, wire } from './fixtures.js';

const base = fixtures.UpdateState.Players[0] as Player;
const player = (Name: string, Shortcut: number, TeamNum: 0 | 1, Score: number, Boost?: number): Player => ({
	...base,
	Name,
	Shortcut,
	TeamNum,
	Score,
	Boost,
});

const players = [player('carl', 3, 1, 200, 10), player('Ana', 1, 0, 100), player('bob', 2, 0, 300, 80), player('Dan', 4, 1, 100, 50)];
const names = (list: readonly Player[]) => list.map((p) => p.Name);

describe('sortPlayers', () => {
	it('keeps the original order and returns a copy without comparators', () => {
		const sorted = sortPlayers(players);
		expect(names(sorted)).toEqual(names(players));
		expect(sorted).not.toBe(players);
	});

	it('does not modify the input', () => {
		sortPlayers(players, byName());
		expect(names(players)).toEqual(['carl', 'Ana', 'bob', 'Dan']);
	});

	it('sorts by team, shortcut and name in both directions', () => {
		expect(names(sortPlayers(players, byShortcut()))).toEqual(['Ana', 'bob', 'carl', 'Dan']);
		expect(names(sortPlayers(players, byShortcut('desc')))).toEqual(['Dan', 'carl', 'bob', 'Ana']);
		expect(names(sortPlayers(players, byName()))).toEqual(['Ana', 'bob', 'carl', 'Dan']);
		// Stable: players of the same team keep their original order.
		expect(names(sortPlayers(players, byTeam()))).toEqual(['Ana', 'bob', 'carl', 'Dan']);
		expect(names(sortPlayers(players, byTeam('desc')))).toEqual(['carl', 'Dan', 'Ana', 'bob']);
	});

	it('uses later comparators to break ties', () => {
		expect(names(sortPlayers(players, byTeam(), byStat('Score')))).toEqual(['bob', 'Ana', 'carl', 'Dan']);
		expect(names(sortPlayers(players, byStat('Score'), byName('desc')))).toEqual(['bob', 'carl', 'Dan', 'Ana']);
	});

	describe('by team combined with another field', () => {
		// Sorting by name or shortcut alone gives a different order than sorting by team first.
		const roster = [player('Zoe', 4, 0, 0), player('amy', 2, 1, 0), player('Bea', 3, 0, 0), player('Cal', 1, 1, 0)];

		it('sorts by team, then by name within each team', () => {
			expect(names(sortPlayers(roster, byName()))).toEqual(['amy', 'Bea', 'Cal', 'Zoe']);
			expect(names(sortPlayers(roster, byTeam(), byName()))).toEqual(['Bea', 'Zoe', 'amy', 'Cal']);
			expect(names(sortPlayers(roster, byTeam('desc'), byName()))).toEqual(['amy', 'Cal', 'Bea', 'Zoe']);
		});

		it('sorts by team, then by shortcut within each team', () => {
			expect(names(sortPlayers(roster, byShortcut()))).toEqual(['Cal', 'amy', 'Bea', 'Zoe']);
			expect(names(sortPlayers(roster, byTeam(), byShortcut()))).toEqual(['Bea', 'Zoe', 'Cal', 'amy']);
			expect(names(sortPlayers(roster, byTeam(), byShortcut('desc')))).toEqual(['Zoe', 'Bea', 'amy', 'Cal']);
		});
	});

	it('puts missing stats last', () => {
		expect(names(sortPlayers(players, byStat('Boost')))).toEqual(['bob', 'Dan', 'carl', 'Ana']);
		expect(names(sortPlayers(players, byStat('Boost', 'asc')))).toEqual(['carl', 'Dan', 'bob', 'Ana']);
	});
});

describe('client sortPlayers option', () => {
	class Socket implements WebSocketLike {
		static last: Socket;
		readyState = 1;
		readonly handlers: Record<string, (event: any) => void> = {};
		constructor() {
			Socket.last = this;
		}
		addEventListener(type: string, listener: (event: any) => void): void {
			this.handlers[type] = listener;
		}
		send(): void {}
		close(): void {}
	}

	function receive(options: ConstructorParameters<typeof RocketLeagueStatsClient>[0]): string[] {
		const client = new RocketLeagueStatsClient({ WebSocket: Socket, ensureStatsApi: false, autoConnect: false, ...options });
		client.connect();
		const listener = vi.fn();
		client.on('UpdateState', (data) => listener(names(data.Players)));
		Socket.last.handlers.message!({ data: wire('UpdateState', { ...fixtures.UpdateState, Players: players }) });
		return listener.mock.calls[0]![0];
	}

	it('keeps the game order by default', () => {
		expect(receive({})).toEqual(['carl', 'Ana', 'bob', 'Dan']);
	});

	it('sorts with one comparator or a list', () => {
		expect(receive({ sortPlayers: byName() })).toEqual(['Ana', 'bob', 'carl', 'Dan']);
		expect(receive({ sortPlayers: [byTeam(), byStat('Score')] })).toEqual(['bob', 'Ana', 'carl', 'Dan']);
	});
});
