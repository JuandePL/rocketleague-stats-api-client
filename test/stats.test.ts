import { describe, expect, it, vi } from 'vitest';
import {
	EsportsSeries,
	getMvp,
	getTeamTotals,
	getTopPlayer,
	MatchTracker,
	type AnyEventListener,
	type Game,
	type Player,
	type StatsApiEvent,
} from '../src/index.js';
import { fixtures } from './fixtures.js';

const basePlayer = fixtures.UpdateState.Players[0] as Player;
const baseGame = fixtures.UpdateState.Game as Game;

function player(Name: string, TeamNum: 0 | 1, extra: Partial<Player> = {}): Player {
	return { ...basePlayer, Name, TeamNum, PrimaryId: `Steam|${Name}|0`, Shortcut: 1, Boost: undefined, bDemolished: false, ...extra };
}

const ev = (Event: string, Data: object = {}) => ({ Event, Data }) as StatsApiEvent;

/** Drives a tracker like the game would. */
class Match {
	clock = 300;
	ballTeam = 255;
	bReplay = false;
	/** In overtime the clock counts up from 0 instead of down. */
	overtime = false;
	players: Player[] = [player('Ana', 0), player('Bob', 1)];
	teams = [
		{ ...baseGame.Teams[0]!, Name: 'Blue', TeamNum: 0, Score: 0 },
		{ ...baseGame.Teams[1]!, Name: 'Orange', TeamNum: 1, Score: 0 },
	];
	constructor(readonly feed: (event: StatsApiEvent) => void) {}

	send(event: StatsApiEvent) {
		this.feed(event);
	}
	tick() {
		this.send(
			ev('UpdateState', {
				Players: this.players,
				Game: { ...baseGame, Teams: this.teams, TimeSeconds: this.clock, bOvertime: this.overtime, bReplay: this.bReplay, Ball: { Speed: 0, TeamNum: this.ballTeam } },
			}),
		);
	}
	/** One second of play: one tick per second keeps the math simple. */
	play(seconds: number) {
		for (let i = 0; i < seconds; i++) {
			this.clock += this.overtime ? 1 : -1;
			this.tick();
		}
	}
	/** Regulation ended tied at 0:00: kickoff countdown, then the overtime round starts. */
	startOvertime() {
		this.clock = 0;
		this.send(ev('CountdownBegin'));
		this.frozen(3);
		this.overtime = true;
		this.send(ev('RoundStarted'));
		this.ballTeam = 255;
	}
	/** The golden goal that ends overtime. */
	goal() {
		this.send(ev('GoalScored', { ...fixtures.GoalScored }));
	}
	/** Ticks with the clock stopped (pause, goal replay, countdown). */
	frozen(ticks: number) {
		for (let i = 0; i < ticks; i++) this.tick();
	}
	hit(team: number, y: number) {
		this.ballTeam = team;
		this.send(ev('BallHit', { Players: [], Ball: { PreHitSpeed: 0, PostHitSpeed: 0, Location: { X: 0, Y: y, Z: 0 } } }));
	}
	start() {
		this.overtime = false;
		this.send(ev('MatchInitialized'));
		this.send(ev('RoundStarted'));
		this.tick();
	}
	end(winner: 0 | 1, score: [number, number]) {
		this.teams[0]!.Score = score[0];
		this.teams[1]!.Score = score[1];
		this.tick();
		this.send(ev('MatchEnded', { WinnerTeamNum: winner }));
	}
}

describe('helpers', () => {
	const players = [
		player('Ana', 0, { Score: 300, Goals: 2, Saves: 1 }),
		player('Bob', 0, { Score: 450, Goals: 1, Saves: 3 }),
		player('Cid', 1, { Score: 500, Goals: 3, Saves: 0 }),
		player('Dee', 1, { Score: 200, Goals: 0, Saves: 4 }),
	];

	it('picks the MVP from the winning team', () => {
		expect(getMvp(players, 0)?.Name).toBe('Bob');
		expect(getMvp(players, 1)?.Name).toBe('Cid');
		expect(getMvp(players)?.Name).toBe('Cid');
		expect(getMvp([])).toBeUndefined();
	});

	it('breaks MVP ties by goals', () => {
		const tied = [player('Ana', 0, { Score: 400, Goals: 1 }), player('Bob', 0, { Score: 400, Goals: 2 })];
		expect(getMvp(tied, 0)?.Name).toBe('Bob');
	});

	it('finds the top player of a stat and sums team totals', () => {
		expect(getTopPlayer(players, 'Saves')?.Name).toBe('Dee');
		const totals = getTeamTotals(players);
		expect(totals.blue).toMatchObject({ players: 2, Score: 750, Goals: 3, Saves: 4 });
		expect(totals.orange).toMatchObject({ players: 2, Score: 700, Goals: 3, Saves: 4 });
	});
});

describe('MatchTracker', () => {
	function setup() {
		const tracker = new MatchTracker();
		const match = new Match((event) => tracker.handle(event));
		return { tracker, match };
	}

	it('accumulates ball possession from Ball.TeamNum', () => {
		const { tracker, match } = setup();
		match.start();
		match.play(5); // untouched (255): not counted
		match.hit(0, -100);
		match.play(30);
		match.hit(1, 100);
		match.play(10);

		const { possession, secondsPlayed } = tracker.getStats();
		expect(secondsPlayed).toBe(45);
		expect(possession.percent).toEqual({ blue: 75, orange: 25 });
		// Ticks are converted to seconds with the clock, so the split follows the tick ratio.
		expect(possession.seconds.blue / possession.seconds.orange).toBeCloseTo(3);
		expect(possession.seconds.blue + possession.seconds.orange).toBeLessThanOrEqual(secondsPlayed);
	});

	it('computes field domination and pressure from the last hit location', () => {
		const { tracker, match } = setup();
		match.start();
		match.hit(1, -2000); // ball in the blue half
		match.play(8);
		match.hit(0, 1500); // ball in the orange half
		match.play(2);

		const { fieldDomination } = tracker.getStats();
		expect(fieldDomination.percent).toEqual({ blueHalf: 80, orangeHalf: 20 });
		expect(fieldDomination.pressure).toEqual({ blue: 20, orange: 80 });
	});

	it('does not count kickoff countdowns, pauses or goal replays', () => {
		const { tracker, match } = setup();
		match.start();
		match.hit(0, -10);
		match.play(10);

		match.send(ev('MatchPaused'));
		match.frozen(5);
		match.send(ev('MatchUnpaused'));

		match.send(ev('GoalScored', { ...fixtures.GoalScored }));
		match.bReplay = true;
		match.frozen(5);
		match.bReplay = false;
		match.send(ev('CountdownBegin'));
		match.tick();
		match.tick();
		match.send(ev('RoundStarted'));
		match.hit(1, 10);
		match.play(10);

		const stats = tracker.getStats();
		expect(stats.secondsPlayed).toBe(20);
		expect(stats.possession.percent).toEqual({ blue: 50, orange: 50 });
	});

	describe('pause', () => {
		it('freezes time, possession and field domination', () => {
			const { tracker, match } = setup();
			match.start();
			match.hit(0, 1000);
			match.play(10);
			const before = tracker.getStats();

			match.send(ev('MatchPaused'));
			expect(tracker.paused).toBe(true);
			match.ballTeam = 1;
			match.hit(1, -1000); // a hit reported during the pause is ignored
			match.frozen(20);
			expect(tracker.getStats()).toEqual(before);

			match.send(ev('MatchUnpaused'));
			expect(tracker.paused).toBe(false);
			match.play(10);
			const after = tracker.getStats();
			expect(after.secondsPlayed).toBe(20);
			// The ball is still counted in the orange half, where it was before the pause.
			expect(after.fieldDomination.percent.orangeHalf).toBe(100);
		});

		it('freezes boost usage', () => {
			const { tracker, match } = setup();
			match.start();
			const ana = match.players[0]!;
			ana.Boost = 100;
			match.play(1);
			ana.Boost = 80;
			match.play(1); // -20

			match.send(ev('MatchPaused'));
			ana.Boost = 50; // a drop during the pause is not counted
			match.frozen(3);
			match.send(ev('MatchUnpaused'));
			ana.Boost = 40;
			match.play(1); // -10 from the value seen during the pause

			expect(tracker.getStats().boost.players.find((p) => p.Name === 'Ana')?.boostUsed).toBe(30);
		});

		it('does not start counting on a mid-round join while paused', () => {
			const { tracker, match } = setup();
			match.send(ev('MatchPaused'));
			match.ballTeam = 0;
			match.tick();
			match.play(5);
			expect(tracker.getStats().secondsPlayed).toBe(0);
		});

		it('pauses during overtime too', () => {
			const { tracker, match } = setup();
			match.clock = 5;
			match.start();
			match.play(5);
			match.startOvertime();
			match.hit(1, -1);
			match.play(3);
			match.send(ev('MatchPaused'));
			match.frozen(10);
			match.send(ev('MatchUnpaused'));
			match.play(2);
			expect(tracker.getStats().secondsPlayed).toBe(10);
		});

		it('pauses the clock in a series match without losing the match', () => {
			const series = new EsportsSeries();
			const match = new Match((event) => series.tracker.handle(event));
			series.start({ games: 1 });
			match.start();
			match.hit(0, 1);
			match.play(5);
			match.send(ev('MatchPaused'));
			match.frozen(30);
			match.send(ev('MatchUnpaused'));
			match.play(5);
			match.end(0, [1, 0]);
			expect(series.getResult()).toMatchObject({ finished: true, winner: 'Blue' });
			expect(series.matches[0]?.secondsPlayed).toBe(10);
		});
	});

	it('starts counting when joining mid-round', () => {
		const { tracker, match } = setup();
		match.ballTeam = 1;
		match.tick();
		match.play(4);
		expect(tracker.getStats().secondsPlayed).toBe(4);
	});

	it('tracks boost spent per player, ignoring pickups and demolitions', () => {
		const { tracker, match } = setup();
		match.start();
		const [ana, bob] = match.players as [Player, Player];
		const step = (anaBoost: number, bobBoost: number, bobDemolished = false) => {
			ana.Boost = anaBoost;
			bob.Boost = bobBoost;
			bob.bDemolished = bobDemolished;
			match.play(1);
		};
		step(33, 50);
		step(20, 40); // Ana -13, Bob -10
		step(100, 30); // pickup, Bob -10
		step(60, 0, true); // Ana -40, Bob demolished: not usage
		step(60, 33); // respawn

		const { boost } = tracker.getStats();
		expect(boost.players.find((p) => p.Name === 'Ana')?.boostUsed).toBe(53);
		expect(boost.players.find((p) => p.Name === 'Bob')?.boostUsed).toBe(20);
		expect(boost.teams).toEqual({ blue: 53, orange: 20 });
	});

	it('emits a summary with the MVP when the match ends, then resets on the next match', () => {
		const { tracker, match } = setup();
		const onEnd = vi.fn();
		tracker.onMatchEnd(onEnd);
		match.players = [player('Ana', 0, { Score: 500 }), player('Bob', 1, { Score: 700 })];
		match.start();
		match.hit(0, -1);
		match.play(10);
		match.end(0, [2, 1]);

		expect(onEnd).toHaveBeenCalledOnce();
		const summary = onEnd.mock.calls[0]![0];
		expect(summary).toMatchObject({ winnerTeamNum: 0, mvp: { Name: 'Ana' }, secondsPlayed: 10 });
		expect(summary.teams.map((t: { Score: number }) => t.Score)).toEqual([2, 1]);
		expect(tracker.matchEnded).toBe(true);

		match.play(5); // podium ticks are ignored
		expect(tracker.getStats().secondsPlayed).toBe(10);

		match.start();
		expect(tracker.matchEnded).toBe(false);
		expect(tracker.getStats().secondsPlayed).toBe(0);
	});

	describe('overtime', () => {
		/** 10 s of regulation with blue in control, then 5 s of overtime with orange in control. */
		function playToOvertime(match: Match) {
			match.clock = 10;
			match.start();
			match.hit(0, 1500); // blue attacks in the orange half
			match.play(10);
			expect(match.clock).toBe(0);
			match.startOvertime();
			match.hit(1, -1500); // orange attacks in the blue half
			match.play(5);
		}

		it('keeps counting while the overtime clock counts up', () => {
			const { tracker, match } = setup();
			playToOvertime(match);

			const stats = tracker.getStats();
			expect(match.clock).toBe(5);
			expect(stats.secondsPlayed).toBe(15);
			expect(stats.possession.seconds.blue / stats.possession.seconds.orange).toBeCloseTo(2);
			expect(stats.fieldDomination.pressure.blue / stats.fieldDomination.pressure.orange).toBeCloseTo(2);
		});

		it('does not count the countdown before overtime', () => {
			const { tracker, match } = setup();
			match.clock = 10;
			match.start();
			match.hit(0, 1);
			match.play(10);
			const regulation = tracker.getStats().secondsPlayed;
			match.startOvertime();
			match.frozen(10); // still in the countdown
			expect(tracker.getStats().secondsPlayed).toBe(regulation);
		});

		it('marks the summary as overtime and credits the golden goal winner', () => {
			const { tracker, match } = setup();
			const onEnd = vi.fn();
			tracker.onMatchEnd(onEnd);
			match.players = [player('Ana', 0, { Score: 300 }), player('Bob', 1, { Score: 250 })];
			playToOvertime(match);
			match.goal();
			match.end(1, [1, 2]);

			const summary = onEnd.mock.calls[0]![0];
			expect(summary).toMatchObject({ overtime: true, winnerTeamNum: 1, secondsPlayed: 15, mvp: { Name: 'Bob' } });
		});

		it('reports overtime as false for a match decided in regulation', () => {
			const { tracker, match } = setup();
			const onEnd = vi.fn();
			tracker.onMatchEnd(onEnd);
			match.start();
			match.play(5);
			match.end(0, [1, 0]);
			expect(onEnd.mock.calls[0]![0].overtime).toBe(false);
		});
	});

	it('attaches to a client through onAny', () => {
		let listener: AnyEventListener | undefined;
		const unsubscribe = vi.fn();
		const tracker = new MatchTracker({
			onAny: (l) => {
				listener = l;
				return unsubscribe;
			},
		});
		const match = new Match((event) => listener!(event));
		match.start();
		match.hit(1, 1);
		match.play(3);
		expect(tracker.getStats().possession.percent.orange).toBe(100);
		tracker.detach();
		expect(unsubscribe).toHaveBeenCalledOnce();
	});
});

describe('EsportsSeries', () => {
	function setup() {
		const series = new EsportsSeries();
		const match = new Match((event) => series.tracker.handle(event));
		/** Plays a full match: `winner` holds possession and wins. */
		const playMatch = (winner: 0 | 1, score: [number, number]) => {
			match.players = [player('Ana', 0, { Score: 400 }), player('Bob', 1, { Score: 300 })];
			match.start();
			match.hit(winner, winner === 0 ? 1000 : -1000);
			match.play(10);
			match.end(winner, score);
		};
		return { series, match, playMatch };
	}

	it('ends a best-of series as soon as a team has the majority', () => {
		const { series, playMatch } = setup();
		const onEnd = vi.fn();
		const onMatch = vi.fn();
		series.onSeriesEnd(onEnd);
		series.onMatchEnd(onMatch);
		series.start({ games: 5 });

		playMatch(0, [3, 1]);
		playMatch(1, [0, 2]);
		playMatch(0, [1, 0]);
		expect(series.status).toBe('running');
		expect(series.getResult().winner).toBeUndefined();
		playMatch(0, [4, 2]);

		expect(series.status).toBe('finished');
		expect(onMatch).toHaveBeenCalledTimes(4);
		expect(onEnd).toHaveBeenCalledOnce();
		const result = onEnd.mock.calls[0]![0];
		expect(result).toMatchObject({ finished: true, winner: 'Blue', mvp: { Name: 'Ana', matches: 4 } });
		expect(result.teams[0]).toMatchObject({ name: 'Blue', wins: 3, goals: 8 });
		expect(result.teams[1]).toMatchObject({ name: 'Orange', wins: 1, goals: 5 });
		expect(result.teams[0].possessionPercent).toBeCloseTo(75, -1);
		expect(result.teams[0].pressurePercent).toBeCloseTo(75, -1);

		playMatch(1, [0, 1]); // after the end: not recorded
		expect(series.matches).toHaveLength(4);
	});

	it('counts overtime wins like any other win', () => {
		const { series, match, playMatch } = setup();
		series.start({ games: 3 });
		playMatch(0, [2, 1]);

		match.players = [player('Ana', 0, { Score: 200 }), player('Bob', 1, { Score: 350 })];
		match.clock = 10;
		match.start();
		match.play(10);
		match.startOvertime();
		match.hit(1, -1000);
		match.play(7);
		match.goal();
		match.end(1, [2, 3]);

		expect(series.status).toBe('running');
		playMatch(1, [0, 1]);

		const result = series.getResult();
		expect(result.matches.map((m) => m.overtime)).toEqual([false, true, false]);
		expect(result).toMatchObject({ finished: true, winner: 'Orange' });
		expect(result.teams.find((t) => t.name === 'Orange')).toMatchObject({ wins: 2, goals: 5 });
	});

	it('plays every game with the play-all format', () => {
		const { series, playMatch } = setup();
		series.start({ games: 3, format: 'play-all' });
		playMatch(0, [1, 0]);
		playMatch(0, [1, 0]);
		expect(series.status).toBe('running');
		playMatch(1, [0, 1]);
		expect(series.getResult()).toMatchObject({ finished: true, winner: 'Blue' });
	});

	it('identifies teams by name when they switch sides', () => {
		const { series, match, playMatch } = setup();
		series.start({ games: 3 });
		match.teams[0]!.Name = 'Team A';
		match.teams[1]!.Name = 'Team B';
		playMatch(0, [1, 0]); // Team A on blue wins
		match.teams[0]!.Name = 'Team B';
		match.teams[1]!.Name = 'Team A';
		playMatch(1, [0, 1]); // Team A on orange wins
		expect(series.getResult()).toMatchObject({ finished: true, winner: 'Team A' });
	});

	it('stop keeps the results, restart and start clear them', () => {
		const { series, playMatch } = setup();
		series.start({ games: 7 });
		playMatch(0, [1, 0]);
		playMatch(1, [0, 1]);
		playMatch(1, [0, 1]);

		series.stop();
		expect(series.status).toBe('stopped');
		playMatch(0, [1, 0]); // not recorded while stopped
		expect(series.getResult()).toMatchObject({ finished: false, winner: 'Orange' });
		expect(series.matches).toHaveLength(3);

		series.restart();
		expect(series.status).toBe('running');
		expect(series.matches).toHaveLength(0);
		expect(series.getResult().options).toEqual({ games: 7, format: 'best-of' });

		series.start({ games: 1 });
		playMatch(1, [0, 1]);
		expect(series.getResult()).toMatchObject({ finished: true, winner: 'Orange' });
	});

	it('rejects invalid game counts and ignores matches before start', () => {
		const { series, playMatch } = setup();
		playMatch(0, [1, 0]);
		expect(series.status).toBe('idle');
		expect(series.matches).toHaveLength(0);
		expect(() => series.start({ games: 0 })).toThrow(RangeError);
		expect(() => series.start({ games: 2.5 })).toThrow(RangeError);
	});
});
