import { describe, expect, it, vi } from 'vitest';
import {
	convertSpeed,
	EsportsSeries,
	type EsportsSeriesOptions,
	findEventAfter,
	formatMatchClock,
	getMvp,
	getTeamTotals,
	getTopPlayer,
	isBot,
	isBotPrimaryId,
	MatchTracker,
	playerKey,
	SeriesTimeoutError,
	timeBetween,
	timeFromPlayerLeftTo,
	timeFromPlayerLeftToMatchEnd,
	timeFromPlayerLeftToNextGoal,
	toMph,
	type AnyEventListener,
	type Game,
	type MatchSummary,
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
	/** `name` touches the ball and sends it against the crossbar of the goal at `y` (negative = blue goal). */
	crossbar(name: string, y: number) {
		const { Name, Shortcut, TeamNum } = this.players.find((p) => p.Name === name)!;
		this.send(ev('BallHit', { Players: [{ Name, Shortcut, TeamNum }], Ball: { PreHitSpeed: 0, PostHitSpeed: 1500, Location: { X: 0, Y: 0, Z: 0 } } }));
		this.bounce(name, y);
	}
	/** A `CrossbarHit` with no touch before it, as the game sends again while the ball stays on the bar. */
	bounce(name: string, y: number) {
		const { Name, Shortcut, TeamNum } = this.players.find((p) => p.Name === name)!;
		this.send(
			ev('CrossbarHit', {
				BallLocation: { X: 0, Y: y, Z: 640 },
				BallSpeed: 1500,
				ImpactForce: 800,
				BallLastTouch: { Player: { Name, Shortcut, TeamNum }, Speed: 1500 },
			}),
		);
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
	it('converts game speeds (km/h) to mph', () => {
		expect(toMph(160.9344)).toBeCloseTo(100);
		expect(toMph(0)).toBe(0);
		expect(convertSpeed(80, 'kmh')).toBe(80);
		expect(convertSpeed(80, 'mph')).toBe(toMph(80));
	});

	it('formats the match clock with two-digit minutes by default', () => {
		expect(formatMatchClock(155)).toBe('02:35');
		expect(formatMatchClock(300)).toBe('05:00');
		expect(formatMatchClock(5)).toBe('00:05');
		expect(formatMatchClock(70, true)).toBe('+01:10');
		expect(formatMatchClock(725, true)).toBe('+12:05');
		expect(formatMatchClock(155, false, { padMinutes: false })).toBe('2:35');
		expect(formatMatchClock(70, true, { padMinutes: false })).toBe('+1:10');
		expect(formatMatchClock(-3)).toBe('00:00');
		expect(formatMatchClock(154.6)).toBe('02:35');
	});

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
		const shooting = getTeamTotals([player('Ana', 0, { Goals: 1, Shots: 4 }), player('Bob', 0, { Goals: 1, Shots: 0 })]);
		expect(shooting.blue.shootingPercent).toBe(50);
		expect(shooting.orange.shootingPercent).toBe(0);
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
		it('freezes time and possession', () => {
			const { tracker, match } = setup();
			match.start();
			match.hit(0, 1000);
			match.play(10);
			const before = tracker.getStats();

			match.send(ev('MatchPaused'));
			expect(tracker.paused).toBe(true);
			match.ballTeam = 1; // orange touches the ball during the pause: not counted
			match.frozen(20);
			expect(tracker.getStats()).toEqual(before);

			match.send(ev('MatchUnpaused'));
			expect(tracker.paused).toBe(false);
			match.play(10);
			const after = tracker.getStats();
			expect(after.secondsPlayed).toBe(20);
			expect(after.possession.seconds.blue / after.possession.seconds.orange).toBeCloseTo(1, 0);
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

	describe('air time', () => {
		it('counts time with the car neither on the ground nor on a wall', () => {
			const { tracker, match } = setup();
			match.start();
			const [ana, bob] = match.players as [Player, Player];
			const air = (p: Player, inAir: boolean, onWall = false) => {
				p.bOnGround = !inAir && !onWall;
				p.bOnWall = onWall;
			};

			air(ana, true);
			air(bob, false);
			match.play(4); // Ana in the air
			air(bob, false, true);
			match.play(3); // Bob on the wall: not air time
			ana.bDemolished = true;
			match.play(2); // demolished: not air time
			ana.bDemolished = false;
			match.send(ev('MatchPaused'));
			air(bob, true);
			match.frozen(5); // paused: not counted
			match.send(ev('MatchUnpaused'));
			match.play(1); // both in the air

			const stats = tracker.getStats();
			const airTime = (name: string) => stats.players.find((p) => p.Name === name)?.airTime;
			// 11 live ticks (start + 10 s) for 10 s of clock: ticks are converted with that ratio.
			expect(airTime('Ana')).toBeCloseTo((8 / 11) * 10);
			expect(airTime('Bob')).toBeCloseTo((1 / 11) * 10);

			// Bob drove on the wall for 5 ticks (3 + 2 while Ana was demolished). The pause doesn't count.
			const wallTime = (name: string) => stats.players.find((p) => p.Name === name)?.onWallTime;
			expect(wallTime('Bob')).toBeCloseTo((5 / 11) * 10);
			expect(wallTime('Ana')).toBe(0);
		});

		it('does not count wall time while demolished, and sums it in the match and series results', () => {
			const series = new EsportsSeries(undefined, { games: 2, format: 'play-all' });
			const match = new Match((event) => series.tracker.handle(event));
			const playOnWall = (wallSeconds: number) => {
				match.players = [player('Ana', 0, { Score: 100 }), player('Bob', 1, { Score: 50 })];
				match.start();
				const ana = match.players[0]!;
				ana.bOnGround = false;
				ana.bOnWall = true;
				match.play(wallSeconds);
				ana.bDemolished = true; // still flagged on the wall, but demolished
				match.play(2);
				match.end(0, [1, 0]);
			};
			playOnWall(4);
			playOnWall(6);

			const [first, second] = series.matches;
			const anaIn = (m: typeof first) => m!.playerResults.find((p) => p.Name === 'Ana')!;
			// Each match: 1 start tick + wall ticks + 2 demolished ticks + 1 end tick, for the measured seconds.
			expect(anaIn(first).onWallTime).toBeCloseTo((4 / 8) * 6);
			expect(anaIn(second).onWallTime).toBeCloseTo((6 / 10) * 8);
			expect(anaIn(first).airTime).toBe(0);
			const total = series.getResult().players.find((p) => p.Name === 'Ana')!;
			expect(total.onWallTime).toBeCloseTo(anaIn(first).onWallTime + anaIn(second).onWallTime);
		});
	});

	describe('live player results', () => {
		it('merges the live scoreboard and tracked stats, with a provisional MVP', () => {
			const { tracker, match } = setup();
			expect(tracker.matchInProgress).toBe(false);
			expect(tracker.getPlayerResults()).toEqual([]);

			match.players = [player('Ana', 0, { Score: 50, Speed: 1000 }), player('Bob', 1, { Score: 200 }), player('Cid', 1, { Score: 10 })];
			match.start();
			match.play(3);
			expect(tracker.matchInProgress).toBe(true);
			// Tied 0-0: the provisional MVP is the best player overall.
			let results = tracker.getPlayerResults();
			expect(results.map((p) => p.Name)).toEqual(['Bob', 'Ana', 'Cid']);
			expect(results.find((p) => p.mvp)?.Name).toBe('Bob');
			expect(results.find((p) => p.Name === 'Ana')).toMatchObject({ team: 'Blue', Score: 50, averageSpeed: 1000, leftEarly: false });

			// Blue leads: the provisional MVP comes from blue. Cid left: leftEarly while not in the match.
			match.teams[0]!.Score = 1;
			match.players = [player('Ana', 0, { Score: 150 }), player('Bob', 1, { Score: 200 })];
			match.play(1);
			results = tracker.getPlayerResults();
			expect(results.find((p) => p.mvp)?.Name).toBe('Ana');
			expect(results.find((p) => p.Name === 'Cid')).toMatchObject({ leftEarly: true, Score: 10 });

			// After the end: the final results, the same as the summary.
			let summary: MatchSummary | undefined;
			tracker.onMatchEnd((s) => (summary = s));
			match.end(0, [1, 0]);
			expect(tracker.matchInProgress).toBe(false);
			expect(tracker.getPlayerResults()).toEqual(summary!.playerResults);
		});

		it('gives series totals that include the match being played, without counting its win', () => {
			const series = new EsportsSeries(undefined, { games: 3 });
			const match = new Match((event) => series.tracker.handle(event));
			match.players = [player('Ana', 0, { Score: 100, Goals: 2 }), player('Bob', 1, { Score: 50 })];
			match.start();
			match.play(5);
			match.end(0, [2, 0]);

			match.players = [player('Ana', 0, { Score: 30, Goals: 1 }), player('Bob', 1, { Score: 80, Goals: 1 })];
			match.teams[0]!.Score = 0;
			match.teams[1]!.Score = 0;
			match.start();
			match.teams[0]!.Score = 1;
			match.teams[1]!.Score = 1;
			match.play(4);

			const final = series.getResult();
			const live = series.getLiveResult();
			expect(live.matches).toHaveLength(1);
			expect(final.players.find((p) => p.Name === 'Ana')).toMatchObject({ Goals: 2, matches: 1 });
			expect(live.players.find((p) => p.Name === 'Ana')).toMatchObject({ Goals: 3, Score: 130, matches: 2 });
			expect(live.teams.find((t) => t.name === 'Blue')).toMatchObject({ wins: 1, goals: 3 });
			expect(live.teams.find((t) => t.name === 'Orange')).toMatchObject({ wins: 0, goals: 1 });

			// Once the match ends, the live result is the recorded one.
			match.end(1, [1, 2]);
			expect(series.getLiveResult()).toEqual(series.getResult());
			expect(series.getResult().teams.find((t) => t.name === 'Orange')?.wins).toBe(1);
		});
	});

	describe('player sessions (joins, leaves and team changes)', () => {
		it('records every time a player leaves and comes back, with the team', () => {
			const { tracker, match } = setup();
			const [ana, bob] = match.players as [Player, Player];
			match.start(); // 05:00
			match.play(10); // 04:50
			match.players = [ana]; // Bob leaves after 04:50
			match.play(5); // 04:45
			match.players = [ana, bob]; // back at 04:44
			match.play(1);
			match.players = [ana]; // leaves again after 04:44
			match.play(4); // 04:40
			match.players = [ana, bob]; // back at 04:39 for good
			match.play(1);

			let summary: MatchSummary | undefined;
			tracker.onMatchEnd((s) => (summary = s));
			match.end(0, [1, 0]);

			const bobResult = summary!.playerResults.find((p) => p.Name === 'Bob')!;
			expect(bobResult).toMatchObject({ joins: 3, leaves: 2, leftEarly: false });
			expect(bobResult.sessions.map((s) => [s.joinedAt.clock, s.leftAt?.clock, s.team])).toEqual([
				['05:00', '04:50', 'Orange'],
				['04:44', '04:44', 'Orange'],
				['04:39', undefined, 'Orange'],
			]);
			const anaResult = summary!.playerResults.find((p) => p.Name === 'Ana')!;
			expect(anaResult).toMatchObject({ joins: 1, leaves: 0 });
			expect(anaResult.sessions).toHaveLength(1);
		});

		it('starts a new session when a player changes team, without counting a leave', () => {
			const { tracker, match } = setup();
			const [ana, bob] = match.players as [Player, Player];
			match.start();
			match.play(3); // 04:57
			bob.TeamNum = 0; // Bob joins blue at 04:56
			match.play(2);
			match.players = [ana]; // then leaves after 04:55

			match.play(1);
			const bobLive = tracker.getPlayerResults().find((p) => p.Name === 'Bob')!;
			expect(bobLive).toMatchObject({ joins: 1, leaves: 1, leftEarly: true });
			expect(bobLive.sessions.map((s) => [s.team, s.joinedAt.clock, s.leftAt?.clock, s.switchedTeam])).toEqual([
				['Orange', '05:00', '04:56', true],
				['Blue', '04:56', '04:55', false],
			]);
		});

		it('shows the open session in the live results and sums joins and leaves over the series', () => {
			const series = new EsportsSeries(undefined, { games: 2, format: 'play-all' });
			const match = new Match((event) => series.tracker.handle(event));
			const playWithQuit = () => {
				const [ana, bob] = [player('Ana', 0), player('Bob', 1)];
				match.players = [ana, bob];
				match.start();
				match.play(2);
				match.players = [ana];
				match.play(2);
				match.players = [ana, bob];
				match.play(2);
				match.end(0, [1, 0]);
			};

			playWithQuit();
			match.players = [player('Ana', 0), player('Bob', 1)];
			match.start();
			match.play(1);
			const open = series.tracker.getPlayerResults().find((p) => p.Name === 'Bob')!.sessions;
			expect(open).toHaveLength(1);
			expect(open[0]!.leftAt).toBeUndefined();
			match.end(0, [1, 0]);

			const bob = series.getResult().players.find((p) => p.Name === 'Bob')!;
			expect(bob).toMatchObject({ joins: 3, leaves: 1, leftEarly: 0, matches: 2 });
		});
	});

	describe('missing car fields', () => {
		it('counts air time when the game leaves out bOnGround / bOnWall instead of sending false', () => {
			const { tracker, match } = setup();
			const [ana, bob] = match.players as [Player, Player];
			ana.bOnGround = undefined;
			ana.bOnWall = undefined; // in the air, both left out
			bob.bOnGround = true;
			match.start();
			match.play(4);
			const air = (name: string) => tracker.getStats().players.find((p) => p.Name === name)?.airTime;
			expect(air('Ana')).toBeCloseTo(4);
			expect(air('Bob')).toBe(0);
		});

		it('counts no air time when the car fields are not sent at all (not spectating)', () => {
			const { tracker, match } = setup();
			match.players = [player('Ana', 0, { Speed: undefined, bOnGround: undefined, bOnWall: undefined, bHasCar: undefined })];
			match.start();
			match.play(4);
			expect(tracker.getStats().players[0]?.airTime).toBe(0);
		});
	});

	describe('live series after a finished series', () => {
		it('shows the new series while its first match is played (autoStart)', () => {
			const series = new EsportsSeries(undefined, { games: 1 });
			const match = new Match((event) => series.tracker.handle(event));
			match.players = [player('Ana', 0, { Score: 100, Goals: 3 }), player('Bob', 1, { Score: 50 })];
			match.start();
			match.play(3);
			match.end(0, [3, 0]);
			expect(series.status).toBe('finished');

			match.players = [player('Ana', 0, { Score: 20, Goals: 1 }), player('Bob', 1, { Score: 10 })];
			match.teams[0]!.Score = 1;
			match.teams[1]!.Score = 0;
			match.start();
			match.play(2);

			const live = series.getLiveResult();
			expect(live).toMatchObject({ status: 'running', finished: false, winner: undefined, matches: [] });
			expect(live.players.find((p) => p.Name === 'Ana')).toMatchObject({ Goals: 1, matches: 1 });
			expect(live.teams.find((t) => t.name === 'Blue')).toMatchObject({ wins: 0, goals: 1 });
			// The finished series is still readable until this match ends.
			expect(series.getResult()).toMatchObject({ status: 'finished', winner: 'Blue' });
			expect(series.getResult().players.find((p) => p.Name === 'Ana')?.Goals).toBe(3);
		});

		it('keeps the finished series after stop()', () => {
			const series = new EsportsSeries(undefined, { games: 1 });
			const match = new Match((event) => series.tracker.handle(event));
			match.start();
			match.end(0, [1, 0]);
			series.stop();
			match.start();
			match.play(2);
			expect(series.getLiveResult()).toEqual(series.getResult());
		});
	});

	describe('average speed', () => {
		it('averages Speed over live ticks, skipping demolished, paused and countdown ticks', () => {
			const { tracker, match } = setup();
			const [ana, bob] = match.players as [Player, Player];
			bob.Speed = undefined; // not spectating Bob's speed
			ana.Speed = 9999; // countdown: not counted
			match.frozen(3);
			ana.Speed = 1000;
			match.start();
			match.play(4);
			ana.Speed = 2000;
			match.play(3);
			ana.bDemolished = true;
			ana.Speed = 0;
			match.play(2); // demolished: not counted
			ana.bDemolished = false;
			match.send(ev('MatchPaused'));
			ana.Speed = 9999;
			match.frozen(5); // paused: not counted
			match.send(ev('MatchUnpaused'));
			ana.Speed = 2000;
			match.play(1);

			const stats = tracker.getStats();
			const anaStats = stats.players.find((p) => p.Name === 'Ana')!;
			// Start tick + 4 ticks at 1000, 3 + 1 ticks at 2000. 9 of 11 live ticks measured.
			expect(anaStats.averageSpeed).toBeCloseTo((5 * 1000 + 4 * 2000) / 9);
			expect(anaStats.drivingTime).toBeCloseTo((9 / 11) * 10);
			// Bob never sent Speed.
			expect(stats.players.find((p) => p.Name === 'Bob')).toMatchObject({ averageSpeed: 0, drivingTime: 0 });
		});

		it('keeps it in the match results and weights the series average by driving time', () => {
			const series = new EsportsSeries(undefined, { games: 2, format: 'play-all' });
			const match = new Match((event) => series.tracker.handle(event));
			const playAt = (speed: number, seconds: number) => {
				match.players = [player('Ana', 0, { Score: 100, Speed: speed }), player('Bob', 1, { Score: 50 })];
				match.start();
				match.play(seconds);
				match.end(0, [1, 0]);
			};
			playAt(1000, 3);
			playAt(2000, 9);

			const [first, second] = series.matches;
			const anaIn = (m: typeof first) => m!.playerResults.find((p) => p.Name === 'Ana')!;
			expect(anaIn(first).averageSpeed).toBe(1000);
			expect(anaIn(second).averageSpeed).toBe(2000);
			const total = series.getResult().players.find((p) => p.Name === 'Ana')!;
			expect(total.drivingTime).toBeCloseTo(anaIn(first).drivingTime + anaIn(second).drivingTime);
			const weighted = (1000 * anaIn(first).drivingTime + 2000 * anaIn(second).drivingTime) / total.drivingTime;
			expect(total.averageSpeed).toBeCloseTo(weighted);
			expect(total.averageSpeed).toBeGreaterThan(1500);
		});
	});

	describe('crossbar hits', () => {
		it('tells attack (opponent goal) from defense (own goal)', () => {
			const { tracker, match } = setup();
			match.start();
			match.crossbar('Ana', 5100); // blue player, orange goal: attack
			match.crossbar('Ana', 5100);
			match.crossbar('Ana', -5100); // blue player, blue goal: defense
			match.crossbar('Bob', -5100); // orange player, blue goal: attack
			match.crossbar('Bob', 5100); // orange player, orange goal: defense

			const crossbar = (name: string) => tracker.getStats().players.find((p) => p.Name === name)?.crossbar;
			expect(crossbar('Ana')).toEqual({ attack: 2, defense: 1, total: 3 });
			expect(crossbar('Bob')).toEqual({ attack: 1, defense: 1, total: 2 });
		});

		it('counts one hit per touch when the game sends several for one impact', () => {
			const { tracker, match } = setup();
			match.start();
			match.crossbar('Ana', 5100);
			match.bounce('Ana', 5100); // same impact, sent again
			match.bounce('Ana', 5100);
			match.tick();
			match.bounce('Ana', 5100); // still no touch since: post then bar
			expect(tracker.getStats().players.find((p) => p.Name === 'Ana')?.crossbar.total).toBe(1);
			match.crossbar('Ana', 5100); // touched again: a new hit
			expect(tracker.getStats().players.find((p) => p.Name === 'Ana')?.crossbar.total).toBe(2);
		});

		it('ignores hits during a pause or a goal replay', () => {
			const { tracker, match } = setup();
			match.start();
			match.send(ev('MatchPaused'));
			match.crossbar('Ana', 5100);
			match.send(ev('MatchUnpaused'));
			match.bReplay = true;
			match.tick();
			match.crossbar('Ana', 5100);
			match.bReplay = false;
			match.tick();
			match.crossbar('Ana', 5100);
			expect(tracker.getStats().players.find((p) => p.Name === 'Ana')?.crossbar.total).toBe(1);
		});
	});

	it('gives the results of every player in the match summary', () => {
		const { tracker, match } = setup();
		const onEnd = vi.fn();
		tracker.onMatchEnd(onEnd);
		match.teams[0]!.Name = 'Team A';
		match.players = [player('Ana', 0, { Score: 500, Goals: 2 }), player('Bob', 1, { Score: 700, Goals: 1 })];
		match.start();
		const ana = match.players[0]!;
		ana.Boost = 100;
		ana.bOnGround = false;
		ana.bOnWall = false;
		match.play(1);
		ana.Boost = 70;
		match.play(1);
		match.crossbar('Ana', 5100);
		match.end(0, [2, 1]);

		const summary = onEnd.mock.calls[0]![0];
		expect(summary.playerResults.map((p: { Name: string }) => p.Name)).toEqual(['Bob', 'Ana']); // sorted by score
		expect(summary.playerResults[1]).toMatchObject({
			Name: 'Ana',
			team: 'Team A',
			mvp: true,
			Score: 500,
			Goals: 2,
			boostUsed: 30,
			crossbar: { attack: 1, defense: 0, total: 1 },
		});
		expect(summary.playerResults[1].airTime).toBeGreaterThan(0);
		expect(summary.playerResults[0]).toMatchObject({ Name: 'Bob', team: 'Orange', mvp: false });
		expect(summary.mvp).toBe(summary.playerResults[1]);
		expect(summary.scoreboard).toHaveLength(2);
	});

	describe('players who leave before the end (rage quit)', () => {
		it('keeps their last scoreboard and tracked stats, flagged as leftEarly', () => {
			const { tracker, match } = setup();
			const onEnd = vi.fn();
			tracker.onMatchEnd(onEnd);
			const quitter = player('Cid', 1, { Score: 900, Goals: 3 });
			match.players = [player('Ana', 0, { Score: 300 }), player('Bob', 1, { Score: 100 }), quitter];
			match.start();
			quitter.Boost = 100;
			quitter.bOnGround = false;
			quitter.bOnWall = false;
			match.play(1);
			quitter.Boost = 40;
			match.play(2);
			match.crossbar('Cid', -5100); // orange player on the blue goal: attack

			match.players = match.players.filter((p) => p !== quitter); // rage quit
			match.play(5);
			match.end(0, [1, 3]);

			const summary = onEnd.mock.calls[0]![0];
			expect(summary.scoreboard.map((p: Player) => p.Name)).toEqual(['Ana', 'Bob']);
			const cid = summary.playerResults.find((p: { Name: string }) => p.Name === 'Cid');
			expect(cid).toMatchObject({
				leftEarly: true,
				PrimaryId: 'Steam|Cid|0',
				team: 'Orange',
				Score: 900,
				Goals: 3,
				boostUsed: 60,
				crossbar: { attack: 1, defense: 0, total: 1 },
				mvp: false,
			});
			expect(cid.airTime).toBeGreaterThan(0);
			expect(summary.playerResults.find((p: { Name: string }) => p.Name === 'Ana')).toMatchObject({ leftEarly: false, mvp: true });
			expect(summary.playerResults[0].Name).toBe('Cid'); // still sorted by score
		});

		it('records when the player left: clock, play time and date', () => {
			const { tracker, match } = setup();
			const onEnd = vi.fn();
			tracker.onMatchEnd(onEnd);
			const cid = player('Cid', 1);
			match.players = [player('Ana', 0), cid];
			match.clock = 160;
			match.start();
			match.play(5); // last seen at 2:35, after 5 s of play
			match.players = match.players.filter((p) => p !== cid);
			match.play(10);
			match.end(0, [1, 0]);

			const results = onEnd.mock.calls[0]![0].playerResults;
			const left = results.find((p: { Name: string }) => p.Name === 'Cid');
			expect(left.leftAt).toMatchObject({ timeSeconds: 155, overtime: false, clock: '02:35', secondsPlayed: 5 });
			expect(left.leftAt.date).toBeInstanceOf(Date);
			expect(results.find((p: { Name: string }) => p.Name === 'Ana')).not.toHaveProperty('leftAt');
		});

		it('records an overtime exit with the overtime clock', () => {
			const { tracker, match } = setup();
			const onEnd = vi.fn();
			tracker.onMatchEnd(onEnd);
			const cid = player('Cid', 1);
			match.players = [player('Ana', 0), cid];
			match.clock = 10;
			match.start();
			match.play(10);
			match.startOvertime();
			match.play(70); // +1:10
			match.players = match.players.filter((p) => p !== cid);
			match.play(5);
			match.goal();
			match.end(0, [1, 0]);

			const left = onEnd.mock.calls[0]![0].playerResults.find((p: { Name: string }) => p.Name === 'Cid');
			expect(left.leftAt).toMatchObject({ timeSeconds: 70, overtime: true, clock: '+01:10', secondsPlayed: 80 });
		});

		describe('time from leaving to the end, a goal or any event', () => {
			/** Cid leaves at 2:35 (5 s played), a goal at 2:25, then the match ends at 2:05. */
			function playWithQuit() {
				const { tracker, match } = setup();
				const onEnd = vi.fn();
				tracker.onMatchEnd(onEnd);
				const cid = player('Cid', 1);
				match.players = [player('Ana', 0), cid];
				match.clock = 160;
				match.start();
				match.play(5);
				match.players = match.players.filter((p) => p !== cid);
				match.play(10);
				match.goal(); // fixture scorer is on blue
				match.send(ev('CountdownBegin'));
				match.frozen(3);
				match.send(ev('RoundStarted'));
				match.play(20);
				match.end(0, [1, 0]);
				const summary: MatchSummary = onEnd.mock.calls[0]![0];
				return { summary, cid: summary.playerResults.find((p) => p.Name === 'Cid')! };
			}

			it('measures the time until the match ended', () => {
				const { summary, cid } = playWithQuit();
				expect(timeFromPlayerLeftToMatchEnd(summary, cid)).toMatchObject({ secondsPlayed: 30, clockSeconds: 30 });
				expect(timeFromPlayerLeftToMatchEnd(summary, cid)!.realSeconds).toBeGreaterThanOrEqual(0);
				expect(summary.endMoment).toMatchObject({ clock: '02:05', secondsPlayed: 35 });
			});

			it('measures the time until the next goal', () => {
				const { summary, cid } = playWithQuit();
				expect(timeFromPlayerLeftToNextGoal(summary, cid)).toMatchObject({ secondsPlayed: 10, clockSeconds: 10 });
				expect(summary.goals).toHaveLength(1);
				expect(summary.goals[0]!.moment.clock).toBe('02:25');
			});

			it('measures the time until any event, with an optional filter, by result or key', () => {
				const { summary, cid } = playWithQuit();
				expect(timeFromPlayerLeftTo(summary, cid.key, 'RoundStarted')).toMatchObject({ secondsPlayed: 10, clockSeconds: 10 });
				// No goal by orange after Cid left.
				expect(timeFromPlayerLeftTo(summary, cid, 'GoalScored', (e) => e.Data.Scorer.TeamNum === 1)).toBeUndefined();
				expect(timeFromPlayerLeftTo(summary, cid, 'GoalScored', (e) => e.Data.Scorer.TeamNum === 0)).toMatchObject({ clockSeconds: 10 });
				expect(findEventAfter(summary, cid.leftAt!, 'CountdownBegin')?.moment.clock).toBe('02:25');
			});

			it('returns undefined for players who stayed, or when there was no goal after leaving', () => {
				const { summary } = playWithQuit();
				const ana = summary.playerResults.find((p) => p.Name === 'Ana')!;
				expect(timeFromPlayerLeftToMatchEnd(summary, ana)).toBeUndefined();
				expect(timeFromPlayerLeftToNextGoal(summary, ana)).toBeUndefined();

				const { tracker, match } = setup();
				const onEnd = vi.fn();
				tracker.onMatchEnd(onEnd);
				const cid = player('Cid', 1);
				match.players = [player('Ana', 0), cid];
				match.start();
				match.play(2);
				match.players = match.players.filter((p) => p !== cid);
				match.play(2);
				match.end(0, [0, 0]);
				expect(timeFromPlayerLeftToNextGoal(onEnd.mock.calls[0]![0], 'Steam|Cid|0')).toBeUndefined();
			});

			it('adds regulation time and overtime on the clock', () => {
				const { tracker, match } = setup();
				const onEnd = vi.fn();
				tracker.onMatchEnd(onEnd);
				const cid = player('Cid', 1);
				match.players = [player('Ana', 0), cid];
				match.clock = 10;
				match.start();
				match.play(5); // leaves at 0:05
				match.players = match.players.filter((p) => p !== cid);
				match.play(5);
				match.startOvertime();
				match.play(10); // +0:10
				match.goal();
				match.end(0, [1, 0]);
				const summary: MatchSummary = onEnd.mock.calls[0]![0];
				expect(timeFromPlayerLeftToNextGoal(summary, 'Steam|Cid|0')).toMatchObject({ clockSeconds: 15, secondsPlayed: 15 });
				expect(summary.endMoment).toMatchObject({ clock: '+00:10', overtime: true });
			});

			it('keeps a timeline of every event except UpdateState, and timeBetween goes both ways', () => {
				const { summary, cid } = playWithQuit();
				const names = summary.timeline.map((entry) => entry.event.Event);
				expect(names[0]).toBe('MatchInitialized');
				expect(names.at(-1)).toBe('MatchEnded');
				expect(names).not.toContain('UpdateState');
				expect(timeBetween(summary.endMoment, cid.leftAt!)).toMatchObject({ secondsPlayed: -30, clockSeconds: -30 });
			});
		});

		it('never makes a player who left the MVP, even with the best score on the winning team', () => {
			const { tracker, match } = setup();
			const onEnd = vi.fn();
			tracker.onMatchEnd(onEnd);
			const quitter = player('Cid', 0, { Score: 900 });
			match.players = [player('Ana', 0, { Score: 300 }), quitter, player('Bob', 1)];
			match.start();
			match.play(2);
			match.players = match.players.filter((p) => p !== quitter);
			match.play(2);
			match.end(0, [1, 0]);
			expect(onEnd.mock.calls[0]![0].mvp.Name).toBe('Ana');
		});

		it('counts a player who leaves and comes back once, not as having left', () => {
			const { tracker, match } = setup();
			const onEnd = vi.fn();
			tracker.onMatchEnd(onEnd);
			const ana = player('Ana', 0);
			const bob = player('Bob', 1);
			match.players = [ana, bob];
			match.start();
			match.players = [ana];
			match.play(3); // Bob disconnected
			match.players = [ana, bob];
			match.play(3); // Bob is back
			match.end(0, [1, 0]);
			const results = onEnd.mock.calls[0]![0].playerResults;
			expect(results).toHaveLength(2);
			expect(results.find((p: { Name: string }) => p.Name === 'Bob').leftEarly).toBe(false);
		});
	});

	describe('rates: shooting %, goal participation, boost per minute, win', () => {
		it('computes them for every player and team, and sets the win only after the end', () => {
			const { tracker, match } = setup();
			const ana = player('Ana', 0, { Goals: 2, Shots: 4, Assists: 1, Boost: 100 });
			const cid = player('Cid', 0, { Goals: 1, Shots: 1 });
			const bob = player('Bob', 1, { Goals: 1, Shots: 2 });
			match.players = [ana, cid, bob];
			match.start();
			match.play(30);
			ana.Boost = 70;
			const dee = player('Dee', 1, { Goals: 0, Shots: 0 });
			match.players = [ana, cid, bob, dee]; // joins halfway
			match.play(30);

			expect(tracker.getPlayerResults().every((p) => p.won === undefined)).toBe(true);
			expect(tracker.getTeamResults().every((t) => t.won === undefined)).toBe(true);

			const onEnd = vi.fn();
			tracker.onMatchEnd(onEnd);
			match.end(0, [3, 1]);
			const summary: MatchSummary = onEnd.mock.calls[0]![0];
			const byName = (name: string) => summary.playerResults.find((p) => p.Name === name)!;

			expect(byName('Ana')).toMatchObject({ won: true, secondsPlayed: 60, shootingPercent: 50, goalParticipation: 100, boostPerMinute: 30 });
			expect(byName('Cid').shootingPercent).toBe(100);
			expect(byName('Cid').goalParticipation).toBeCloseTo(100 / 3);
			expect(byName('Bob')).toMatchObject({ won: false, shootingPercent: 50, goalParticipation: 100 });
			// Seen from the first tick she was in.
			expect(byName('Dee')).toMatchObject({ secondsPlayed: 29, shootingPercent: 0, goalParticipation: 0, boostPerMinute: 0 });

			expect(summary.teamResults).toEqual([
				{ TeamNum: 0, name: 'Blue', goals: 3, shots: 5, shootingPercent: 60, won: true, boostUsed: 30, boostPerMinute: 30, possessionPercent: 0 },
				{ TeamNum: 1, name: 'Orange', goals: 1, shots: 2, shootingPercent: 50, won: false, boostUsed: 0, boostPerMinute: 0, possessionPercent: 0 },
			]);
			expect(tracker.getTeamResults()).toEqual(summary.teamResults);
		});
	});

	it('stores the PrimaryId of every player in the stats', () => {
		const { tracker, match } = setup();
		match.start();
		match.players[0]!.Boost = 50;
		match.play(1);
		const stats = tracker.getStats();
		expect(stats.players.map((p) => p.PrimaryId)).toEqual(['Steam|Ana|0', 'Steam|Bob|0']);
		expect(stats.boost.players.map((p) => p.PrimaryId)).toEqual(['Steam|Ana|0', 'Steam|Bob|0']);
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
	function setup(options: EsportsSeriesOptions = {}) {
		const series = new EsportsSeries(undefined, options);
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
		expect(result.teams[0]).not.toHaveProperty('pressurePercent');

		// With autoStart (default), the next match starts a new series.
		playMatch(1, [0, 1]);
		expect(series.status).toBe('running');
		expect(series.matches).toHaveLength(1);
	});

	it('gives win %, shooting %, goal participation and boost per minute over the series', () => {
		const { series, match } = setup({ games: 3, format: 'play-all' });
		const ana = player('Ana', 0, { Goals: 1, Shots: 2, Boost: 100 });
		match.players = [ana, player('Bob', 1, { Goals: 0, Shots: 1 })];
		match.start();
		match.play(5);
		ana.Boost = 50;
		match.play(5);
		match.end(0, [1, 0]);

		match.players = [player('Ana', 0, { Goals: 1, Shots: 2, Assists: 1 }), player('Bob', 1, { Goals: 3, Shots: 3 })];
		match.start();
		match.play(10);
		match.end(1, [2, 3]);

		const result = series.getResult();
		const team = (name: string) => result.teams.find((t) => t.name === name)!;
		const who = (name: string) => result.players.find((p) => p.Name === name)!;
		expect(team('Blue')).toMatchObject({
			matches: 2,
			wins: 1,
			winPercent: 50,
			goals: 3,
			shots: 4,
			shootingPercent: 50,
			boostUsed: 50,
			secondsPlayed: 20,
			boostPerMinute: 150,
		});
		expect(team('Orange')).toMatchObject({ matches: 2, wins: 1, winPercent: 50, goals: 3, shots: 4, shootingPercent: 75 });
		expect(who('Ana')).toMatchObject({ wins: 1, winPercent: 50, teamGoals: 3, shootingPercent: 50, goalParticipation: 100, secondsPlayed: 20, boostPerMinute: 150 });
		expect(who('Bob')).toMatchObject({ wins: 1, winPercent: 50, teamGoals: 3, shootingPercent: 75, goalParticipation: 100 });

		// The match being played counts as played, but not for the win %.
		match.start();
		match.play(5);
		const live = series.getLiveResult();
		expect(live.teams.find((t) => t.name === 'Blue')).toMatchObject({ matches: 3, winPercent: 50 });
		expect(live.players.find((p) => p.Name === 'Ana')).toMatchObject({ matches: 3, winPercent: 50 });
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

	describe('autoStart', () => {
		it('records from the start without calling start(), as a best of 5 by default', () => {
			const { series, playMatch } = setup();
			expect(series.status).toBe('running');
			expect(series.autoStart).toBe(true);
			playMatch(0, [1, 0]);
			expect(series.matches).toHaveLength(1);
			expect(series.getResult().options).toEqual({ games: 5, format: 'best-of', timeouts: 0, timeoutSeconds: 0 });
		});

		it('starts a new series by itself after one finishes, keeping the old result until then', () => {
			const { series, playMatch } = setup({ games: 3 });
			const onStart = vi.fn();
			const onEnd = vi.fn();
			series.onSeriesStart(onStart);
			series.onSeriesEnd(onEnd);

			playMatch(1, [0, 1]);
			playMatch(1, [0, 2]);
			expect(series.status).toBe('finished');
			expect(series.getResult()).toMatchObject({ winner: 'Orange', finished: true });

			playMatch(0, [1, 0]); // first match of the next series
			expect(onStart).toHaveBeenCalledWith({ games: 3, format: 'best-of', timeouts: 0, timeoutSeconds: 0 });
			expect(series.status).toBe('running');
			expect(series.matches).toHaveLength(1);
			expect(series.getResult().teams[0]).toMatchObject({ name: 'Blue', wins: 1 });

			playMatch(0, [1, 0]);
			expect(onEnd).toHaveBeenCalledTimes(2);
			expect(onEnd.mock.calls[1]![0]).toMatchObject({ winner: 'Blue' });
		});

		it('does not restart after stop() until start() or restart()', () => {
			const { series, playMatch } = setup({ games: 1 });
			series.stop();
			playMatch(0, [1, 0]);
			expect(series.matches).toHaveLength(0);

			series.restart();
			playMatch(0, [1, 0]);
			expect(series.status).toBe('finished');
			playMatch(1, [0, 1]); // the automatic restart is back on
			expect(series.status).toBe('finished');
			expect(series.getResult().winner).toBe('Orange');
		});

		it('records nothing after the end when disabled', () => {
			const { series, playMatch } = setup({ autoStart: false });
			expect(series.status).toBe('idle');
			series.start({ games: 1 });
			playMatch(0, [1, 0]);
			playMatch(1, [0, 1]);
			expect(series.matches).toHaveLength(1);
			expect(series.getResult().winner).toBe('Blue');
		});
	});

	it('keeps the player results of every match and sums them for the series', () => {
		const { series, match } = setup({ games: 2, format: 'play-all' });
		const playWithStats = (crossbarY: number) => {
			match.players = [player('Ana', 0, { Score: 400, Goals: 1 }), player('Bob', 1, { Score: 300 })];
			match.start();
			match.players[0]!.bOnGround = false; // Ana always in the air
			match.players[0]!.bOnWall = false;
			match.hit(0, 1000);
			match.play(10);
			match.crossbar('Ana', crossbarY);
			match.end(0, [1, 0]);
		};
		playWithStats(5100); // attack
		playWithStats(-5100); // defense

		const result = series.getResult();
		expect(result.matches).toHaveLength(2);
		for (const m of result.matches) {
			expect(m.playerResults.map((p) => p.Name)).toEqual(['Ana', 'Bob']);
			expect(m.playerResults[0]).toMatchObject({ mvp: true, Score: 400 });
		}
		expect(result.matches[0]!.playerResults[0]!.crossbar).toEqual({ attack: 1, defense: 0, total: 1 });
		expect(result.matches[1]!.playerResults[0]!.crossbar).toEqual({ attack: 0, defense: 1, total: 1 });

		const ana = result.players.find((p) => p.Name === 'Ana')!;
		expect(ana).toMatchObject({ matches: 2, mvps: 2, Score: 800, Goals: 2, crossbar: { attack: 1, defense: 1, total: 2 } });
		const airPerMatch = result.matches.map((m) => m.playerResults[0]!.airTime);
		expect(ana.airTime).toBeCloseTo(airPerMatch[0]! + airPerMatch[1]!);
		expect(ana.airTime).toBeGreaterThan(15);
		expect(result.players.find((p) => p.Name === 'Bob')?.airTime).toBe(0);
	});

	it('counts matches a player left early, with their stats and PrimaryId', () => {
		const { series, match } = setup({ games: 2, format: 'play-all' });
		const playMatch = (cidQuits: boolean) => {
			const cid = player('Cid', 1, { Score: 200, Goals: 1 });
			match.players = [player('Ana', 0, { Score: 400 }), cid];
			match.start();
			match.play(3);
			if (cidQuits) match.players = match.players.filter((p) => p !== cid);
			match.play(3);
			match.end(0, [2, 1]);
		};
		playMatch(true);
		playMatch(false);

		const cid = series.getResult().players.find((p) => p.Name === 'Cid')!;
		expect(cid).toMatchObject({ PrimaryId: 'Steam|Cid|0', matches: 2, leftEarly: 1, Score: 400, Goals: 2 });
		expect(series.matches[0]!.playerResults.find((p) => p.Name === 'Cid')?.leftEarly).toBe(true);
		expect(series.getResult().players.find((p) => p.Name === 'Ana')).toMatchObject({ PrimaryId: 'Steam|Ana|0', leftEarly: 0 });
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
		expect(series.getResult().options).toEqual({ games: 7, format: 'best-of', timeouts: 0, timeoutSeconds: 0 });

		series.start({ games: 1 });
		playMatch(1, [0, 1]);
		expect(series.getResult()).toMatchObject({ finished: true, winner: 'Orange' });
	});

	describe('player identity', () => {
		const bot = (Name: string, TeamNum: 0 | 1, extra: Partial<Player> = {}) => player(Name, TeamNum, { PrimaryId: 'Unknown|0|0', ...extra });

		it('uses the PrimaryId for real accounts and the name for bots', () => {
			expect(playerKey({ Name: 'Ana', Shortcut: 1, TeamNum: 0, PrimaryId: 'Steam|765|0' })).toBe('Steam|765|0');
			expect(playerKey({ Name: 'Ana', Shortcut: 1, TeamNum: 0, PrimaryId: 'Steam|765|1' })).toBe('Steam|765|1'); // splitscreen
			expect(playerKey({ Name: 'Armstrong', Shortcut: 1, TeamNum: 0, PrimaryId: 'Unknown|0|0' })).toBe('bot:Armstrong');
			expect(playerKey({ Name: 'Ana', Shortcut: 1, TeamNum: 0 })).toBe('bot:Ana'); // no PrimaryId
			expect(isBotPrimaryId('Unknown|0|0')).toBe(true);
			expect(isBotPrimaryId('Epic|0|0')).toBe(true);
			expect(isBotPrimaryId('')).toBe(true);
			expect(isBotPrimaryId('Epic|abc|0')).toBe(false);
			expect(isBot({ PrimaryId: 'Steam|765|0' })).toBe(false);
		});

		it('keeps a player who changes their name between matches as one player', () => {
			const { series, match } = setup({ games: 2, format: 'play-all' });
			const playAs = (name: string) => {
				match.players = [player(name, 0, { PrimaryId: 'Steam|765|0', Score: 100 }), bot('Armstrong', 1)];
				match.start();
				match.play(3);
				match.end(0, [1, 0]);
			};
			playAs('Ana');
			playAs('AnaPro');

			const players = series.getResult().players.filter((p) => !p.bot);
			expect(players).toHaveLength(1);
			expect(players[0]).toMatchObject({ key: 'Steam|765|0', Name: 'AnaPro', names: ['Ana', 'AnaPro'], matches: 2, Score: 200 });
		});

		it('keeps bots apart by name, all sharing Unknown|0|0', () => {
			const { series, match } = setup({ games: 1 });
			match.players = [bot('Armstrong', 0, { Score: 50 }), bot('Bandit', 0, { Score: 70 }), bot('Casper', 1)];
			match.start();
			match.play(3);
			match.end(0, [1, 0]);

			const players = series.getResult().players;
			expect(players.map((p) => p.key).sort()).toEqual(['bot:Armstrong', 'bot:Bandit', 'bot:Casper']);
			expect(players.every((p) => p.bot && p.PrimaryId === 'Unknown|0|0')).toBe(true);
			expect(series.matches[0]!.mvp).toMatchObject({ Name: 'Bandit', bot: true });
		});

		it('counts crossbar hits on the right player after a name change in the same match', () => {
			const { series, match } = setup();
			const { tracker } = series;
			const ana = player('Ana', 0, { PrimaryId: 'Steam|765|0' });
			match.players = [ana, bot('Armstrong', 1)];
			match.start();
			match.play(1);
			ana.Name = 'AnaPro';
			match.play(1);
			match.crossbar('AnaPro', 5100);
			const stats = tracker.getStats().players.filter((p) => !p.bot);
			expect(stats).toHaveLength(1);
			expect(stats[0]).toMatchObject({ key: 'Steam|765|0', Name: 'AnaPro', crossbar: { attack: 1 } });
		});

		it('accepts a custom identifyPlayer to merge accounts', () => {
			// The same person on Steam and on Epic.
			const aliases: Record<string, string> = { 'Steam|765|0': 'ana', 'Epic|abc|0': 'ana' };
			const { series, match } = setup({
				games: 2,
				format: 'play-all',
				identifyPlayer: (p) => (p.PrimaryId && aliases[p.PrimaryId]) || playerKey(p),
			});
			const playWith = (primaryId: string) => {
				match.players = [player('Ana', 0, { PrimaryId: primaryId, Score: 100 }), bot('Armstrong', 1)];
				match.start();
				match.play(3);
				match.end(0, [1, 0]);
			};
			playWith('Steam|765|0');
			playWith('Epic|abc|0');

			const ana = series.getResult().players.find((p) => p.key === 'ana');
			expect(ana).toMatchObject({ matches: 2, Score: 200, PrimaryId: 'Epic|abc|0' });
			expect(series.tracker.keyOf({ Name: 'Ana', Shortcut: 1, TeamNum: 0, PrimaryId: 'Steam|765|0' })).toBe('ana');
		});
	});

	describe('timeouts', () => {
		it('lets each team call its timeouts only between matches', () => {
			const { series, match, playMatch } = setup({ games: 5, timeouts: 1 });
			const onStart = vi.fn();
			const onEnd = vi.fn();
			series.onTimeoutStart(onStart);
			series.onTimeoutEnd(onEnd);

			expect(series.timeoutRefusal('Blue')).toBe('no-match-played');
			playMatch(0, [1, 0]);
			match.start();
			match.play(3);
			expect(series.timeoutRefusal('Blue')).toBe('match-in-progress');
			match.end(0, [1, 0]);

			expect(series.timeoutRefusal('Green')).toBe('unknown-team');
			expect(series.timeoutsLeft('Blue')).toBe(1);
			const timeout = series.callTimeout('Blue');
			expect(timeout).toMatchObject({ team: 'Blue', afterMatch: 2, endsAt: undefined, endReason: undefined });
			expect(onStart).toHaveBeenCalledOnce();
			expect(series.activeTimeout).toMatchObject({ team: 'Blue' });
			expect(series.timeoutRefusal('Orange')).toBe('timeout-active');
			expect(() => series.callTimeout('Orange')).toThrow(SeriesTimeoutError);

			// The next match ends the timeout.
			playMatch(1, [0, 1]);
			expect(onEnd).toHaveBeenCalledOnce();
			expect(onEnd.mock.calls[0]![0]).toMatchObject({ team: 'Blue', endReason: 'match-started' });
			expect(series.activeTimeout).toBeUndefined();

			let error: unknown;
			try {
				series.callTimeout('Blue');
			} catch (e) {
				error = e;
			}
			expect(error).toBeInstanceOf(SeriesTimeoutError);
			expect(error).toMatchObject({ reason: 'no-timeouts-left', team: 'Blue' });

			expect(series.endTimeout()).toBeUndefined();
			series.callTimeout('Orange');
			expect(series.endTimeout()).toMatchObject({ team: 'Orange', afterMatch: 3, endReason: 'ended' });

			const result = series.getResult();
			expect(result.timeouts.map((t) => [t.team, t.endReason])).toEqual([
				['Blue', 'match-started'],
				['Orange', 'ended'],
			]);
			expect(result.teams.find((t) => t.name === 'Blue')).toMatchObject({ timeoutsUsed: 1, timeoutsLeft: 0 });
			expect(result.teams.find((t) => t.name === 'Orange')).toMatchObject({ timeoutsUsed: 1, timeoutsLeft: 0 });
		});

		it('can be called in the lobby until the next match is initialized', () => {
			const { series, match, playMatch } = setup({ games: 5, timeouts: 1 });
			const onEnd = vi.fn();
			series.onTimeoutEnd(onEnd);
			playMatch(0, [1, 0]);

			// Lobby of the next match: MatchCreated and UpdateState, but no MatchInitialized yet.
			match.send(ev('MatchCreated'));
			match.frozen(3);
			expect(series.tracker.matchInProgress).toBe(true);
			expect(series.tracker.matchStarted).toBe(false);
			// The lobby is not counted as a match in the live totals.
			expect(series.getLiveResult().teams.find((t) => t.name === 'Blue')).toMatchObject({ matches: 1 });
			expect(series.callTimeout('Orange')).toMatchObject({ team: 'Orange', afterMatch: 1 });
			match.frozen(3);
			expect(onEnd).not.toHaveBeenCalled();

			match.send(ev('MatchInitialized'));
			expect(onEnd.mock.calls[0]![0]).toMatchObject({ team: 'Orange', endReason: 'match-started' });
			expect(series.tracker.matchStarted).toBe(true);
			expect(series.timeoutRefusal('Blue')).toBe('match-in-progress');
		});

		it('counts a match joined midway from its first UpdateState', () => {
			const { series, match, playMatch } = setup({ games: 5 });
			const onStart = vi.fn();
			series.tracker.onMatchStart(onStart);
			// Connected mid-match: no MatchCreated, MatchInitialized nor RoundStarted, only UpdateState.
			match.play(3);
			expect(series.tracker.matchStarted).toBe(true);
			expect(onStart).toHaveBeenCalledOnce();
			expect(series.getLiveResult().teams.find((t) => t.name === 'Blue')).toMatchObject({ matches: 1 });
			match.end(0, [1, 0]);
			expect(series.matches).toHaveLength(1);

			// The next match goes through the lobby as usual.
			match.send(ev('MatchCreated'));
			match.frozen(2);
			expect(series.tracker.matchStarted).toBe(false);
			expect(onStart).toHaveBeenCalledOnce();
			playMatch(0, [1, 0]);
			expect(onStart).toHaveBeenCalledTimes(2);
		});

		it('accepts the TeamNum of the last finished match instead of the name', () => {
			const { series, match, playMatch } = setup({ games: 5, format: 'play-all', timeouts: 1 });
			playMatch(0, [1, 0]);
			expect(series.teamOf(1)).toBe('Orange');
			expect(series.timeoutsLeft(1)).toBe(1);
			expect(series.hasTimeoutsLeft(1)).toBe(true);
			expect(series.callTimeout(1)).toMatchObject({ team: 'Orange' });
			series.endTimeout();
			expect(series.timeoutsLeft('Orange')).toBe(0);
			expect(series.hasTimeoutsLeft('Orange')).toBe(false);
			expect(series.hasTimeoutsLeft('Blue')).toBe(true);
			expect(series.hasTimeoutsLeft('Green')).toBe(false);
			expect(series.timeoutRefusal(1)).toBe('no-timeouts-left');
			expect(series.timeoutRefusal(5)).toBe('unknown-team');

			// The teams switch sides: TeamNum 1 is now Blue.
			match.teams = [
				{ ...match.teams[1]!, Name: 'Orange', TeamNum: 0 },
				{ ...match.teams[0]!, Name: 'Blue', TeamNum: 1 },
			];
			playMatch(0, [1, 0]);
			expect(series.teamOf(1)).toBe('Blue');
			expect(series.callTimeout(1)).toMatchObject({ team: 'Blue' });
			expect(() => series.callTimeout(0)).toThrow(SeriesTimeoutError);
		});

		it('ends a timeout when its time runs out', () => {
			vi.useFakeTimers();
			try {
				const { series, playMatch } = setup({ games: 3, timeouts: 2, timeoutSeconds: 60 });
				const onEnd = vi.fn();
				series.onTimeoutEnd(onEnd);
				playMatch(0, [1, 0]);
				const timeout = series.callTimeout('Orange');
				expect(timeout.endsAt!.getTime() - timeout.startedAt.getTime()).toBe(60_000);
				expect(series.getResult().activeTimeout).toMatchObject({ team: 'Orange' });

				vi.advanceTimersByTime(59_999);
				expect(onEnd).not.toHaveBeenCalled();
				vi.advanceTimersByTime(1);
				expect(onEnd.mock.calls[0]![0]).toMatchObject({ team: 'Orange', endReason: 'expired' });
				expect(series.timeoutsLeft('Orange')).toBe(1);
				expect(series.canCallTimeout('Orange')).toBe(true);
			} finally {
				vi.useRealTimers();
			}
		});

		it('is off by default, not allowed once the series is over, and cleared by a new series', () => {
			expect(setup().series.timeoutRefusal('Blue')).toBe('disabled');

			const { series, playMatch } = setup({ games: 3, timeouts: 1 });
			const onEnd = vi.fn();
			series.onTimeoutEnd(onEnd);
			playMatch(0, [1, 0]);
			series.callTimeout('Blue');
			series.restart();
			expect(onEnd.mock.calls[0]![0]).toMatchObject({ endReason: 'cancelled' });
			expect(series.getResult().timeouts).toEqual([]);

			playMatch(0, [1, 0]);
			playMatch(0, [1, 0]);
			expect(series.status).toBe('finished');
			expect(series.timeoutRefusal('Orange')).toBe('not-running');

			expect(() => new EsportsSeries(undefined, { timeouts: -1 })).toThrow(RangeError);
			expect(() => new EsportsSeries(undefined, { timeoutSeconds: -5 })).toThrow(RangeError);
		});
	});

	it('rejects invalid game counts and ignores matches before start', () => {
		expect(() => new EsportsSeries(undefined, { games: 0 })).toThrow(RangeError);
		const { series, playMatch } = setup({ autoStart: false });
		playMatch(0, [1, 0]);
		expect(series.status).toBe('idle');
		expect(series.matches).toHaveLength(0);
		expect(() => series.start({ games: 0 })).toThrow(RangeError);
		expect(() => series.start({ games: 2.5 })).toThrow(RangeError);
	});
});
