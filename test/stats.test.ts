import { describe, expect, it, vi } from 'vitest';
import {
	convertSpeed,
	EsportsSeries,
	type EsportsSeriesOptions,
	EventRelay,
	findEventAfter,
	formatMatchClock,
	getMvp,
	getTeamTotals,
	getTopPlayer,
	isBot,
	isBotPrimaryId,
	MatchTracker,
	playerKey,
	renameSnapshotTeams,
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
// The fixture is of a match that is over: these are being played.
const baseGame = { ...fixtures.UpdateState.Game, bHasWinner: false, Winner: '' } as Game;

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
			// The new series started with the match.
			expect(series.getResult()).toMatchObject({ status: 'running', winner: undefined, matches: [], players: [] });
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
			].map((team) => expect.objectContaining(team)));
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

		describe('after a finished series', () => {
			/** A finished best of 3 (Blue 2 - 0), left on its end screen. */
			function finished(options: EsportsSeriesOptions = {}) {
				const context = setup({ games: 3, ...options });
				context.playMatch(0, [1, 0]);
				context.playMatch(0, [2, 0]);
				return context;
			}
			const update = (MatchGuid: string | undefined, game: Partial<Game> = {}) =>
				ev('UpdateState', { MatchGuid, Players: [], Game: { ...baseGame, bHasWinner: false, bReplay: false, ...game } });

			it('starts the next series when the next match starts, not when it ends', () => {
				const { series, match } = finished();
				const onStart = vi.fn();
				series.onSeriesStart(onStart);

				// The lobby of the next match still shows the finished series.
				match.send(ev('MatchDestroyed'));
				match.send(ev('MatchCreated'));
				match.tick();
				expect(series.getResult()).toMatchObject({ status: 'finished', winner: 'Blue' });
				expect(onStart).not.toHaveBeenCalled();

				match.send(ev('MatchInitialized'));
				expect(onStart).toHaveBeenCalledOnce();
				expect(series.getResult()).toMatchObject({ status: 'running', matches: [], winner: undefined, manualWins: {} });

				match.send(ev('RoundStarted'));
				match.play(5);
				match.end(1, [0, 1]);
				expect(onStart).toHaveBeenCalledOnce();
				expect(series.matches).toHaveLength(1);
			});

			it('has started when tracker.onMatchStart listeners are called', () => {
				const { series, match } = finished();
				let status: string | undefined;
				series.tracker.onMatchStart(() => (status = series.status));
				match.send(ev('MatchInitialized'));
				expect(status).toBe('running');
			});

			it('emits an update when it starts', () => {
				const { series, match } = finished();
				const onUpdate = vi.fn();
				series.onUpdate(onUpdate);
				match.send(ev('MatchInitialized'));
				expect(onUpdate.mock.calls[0]![0]).toMatchObject({ status: 'running', matches: [] });
			});

			it('starts from RoundStarted when MatchInitialized was missed', () => {
				const { series, match } = finished();
				match.send(ev('MatchCreated'));
				match.send(ev('RoundStarted'));
				expect(series.status).toBe('running');
				expect(series.matches).toHaveLength(0);
			});

			it('keeps the wins given by hand to the new series during its first match', () => {
				const { series, match } = finished();
				match.start();
				series.adjustWins('Orange', 1);
				match.play(3);
				match.end(0, [1, 0]);
				expect(series.winsOf('Orange')).toBe(1);
				expect(series.winsOf('Blue')).toBe(1);
			});

			it('keeps a first match left before its end in the new series', () => {
				const { series, match } = finished();
				match.start();
				match.play(5);
				match.send(ev('MatchDestroyed'));
				expect(series.getResult()).toMatchObject({ status: 'running', matches: [] });
				expect(series.abortedMatches).toHaveLength(1);
			});

			it('keeps the finished series after stop()', () => {
				const { series, match } = finished();
				series.stop();
				match.start();
				expect(series.getResult()).toMatchObject({ status: 'finished', winner: 'Blue' });
			});

			it('keeps the finished series without autoStart', () => {
				const { series, match } = setup({ autoStart: false });
				series.start({ games: 1 });
				match.start();
				match.play(2);
				match.end(0, [1, 0]);
				match.start();
				expect(series.status).toBe('finished');
			});

			it('keeps a restored series when joining the end screen of its last match', () => {
				const restored = setup();
				restored.series.restore(finished().series.snapshot());
				for (const bReplay of [false, true, true]) restored.series.tracker.handle(update('last', { bHasWinner: true, bReplay, TimeSeconds: 0 }));
				expect(restored.series.tracker.matchStarted).toBe(false);
				expect(restored.series.getResult()).toMatchObject({ status: 'finished', winner: 'Blue' });
				expect(restored.series.getLiveResult().status).toBe('finished');
			});

			it('starts when a restored series joins the next match midway', () => {
				const restored = setup();
				restored.series.restore(finished().series.snapshot());
				restored.series.tracker.handle(update('next', { TimeSeconds: 120 }));
				expect(restored.series.status).toBe('running');
				expect(restored.series.matches).toHaveLength(0);
			});

			it('still records a match whose start was never seen', () => {
				const restored = setup();
				restored.series.restore(finished().series.snapshot());
				restored.series.tracker.handle(update('next', { bHasWinner: true }));
				restored.series.tracker.handle(ev('MatchEnded', { WinnerTeamNum: 1 }));
				expect(restored.series.status).toBe('running');
				expect(restored.series.matches).toHaveLength(1);
			});

			it('starts with another match whose MatchCreated and MatchInitialized were missed', () => {
				const { series, match } = setup({ games: 1 });
				match.send(update('first'));
				match.send(ev('MatchEnded', { WinnerTeamNum: 0 }));

				// Not another match: its end screen, a replay, or no guid to tell them apart.
				match.send(update('first'));
				match.send(update('second', { bHasWinner: true }));
				match.send(update('second', { bReplay: true }));
				match.send(update(''));
				match.send(update(undefined));
				expect(series.status).toBe('finished');
				expect(series.tracker.matchEnded).toBe(true);

				match.send(update('second'));
				expect(series.status).toBe('running');
				expect(series.tracker.matchStarted).toBe(true);
				match.send(ev('MatchEnded', { WinnerTeamNum: 1 }));
				expect(series.getResult().matches.map((m) => [m.matchGuid, m.winnerTeamNum])).toEqual([['second', 1]]);
			});
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

		it('keeps a match left before its end apart, and allows timeouts after it', () => {
			const { series, match, playMatch } = setup({ games: 3, timeouts: 1 });
			const onAbort = vi.fn();
			series.onMatchAbort(onAbort);
			playMatch(0, [2, 0]);

			// Second match: played for a while, then everyone leaves the lobby.
			match.players = [player('Ana', 0, { Score: 100, Goals: 1 }), player('Bob', 1, { Score: 300, Goals: 1 })];
			match.send(ev('MatchCreated'));
			match.start();
			match.teams[0]!.Score = 1;
			match.teams[1]!.Score = 0;
			match.play(5);
			expect(series.timeoutRefusal('Blue')).toBe('match-in-progress');
			match.send(ev('MatchDestroyed'));

			const { tracker } = series;
			expect(tracker).toMatchObject({ matchStarted: false, matchAborted: true, matchEnded: false });
			expect(onAbort).toHaveBeenCalledOnce();
			const aborted = onAbort.mock.calls[0]![0];
			expect(aborted).toMatchObject({ winnerTeamNum: undefined, secondsPlayed: 5, mvp: { Name: 'Bob' } });
			expect(aborted.playerResults.every((p: { won?: boolean }) => p.won === undefined)).toBe(true);
			expect(aborted.teamResults.every((t: { won?: boolean }) => t.won === undefined)).toBe(true);
			expect(aborted.endMoment.timeSeconds).toBe(match.clock);

			// Kept apart: nothing of it counts in the results.
			const result = series.getResult();
			expect(result.abortedMatches).toHaveLength(1);
			expect(result.matches).toHaveLength(1);
			expect(result.teams.find((t) => t.name === 'Blue')).toMatchObject({ matches: 1, wins: 1, goals: 2 });
			expect(result.players.find((p) => p.Name === 'Ana')).toMatchObject({ matches: 1, Score: 400 });
			expect(series.getLiveResult()).toEqual(result);

			// Out of the match: timeouts can be called again.
			expect(series.canCallTimeout('Orange')).toBe(true);

			// The match is played again and counts normally. A new series clears the aborted ones.
			playMatch(0, [1, 0]);
			expect(series.getResult()).toMatchObject({ finished: true, winner: 'Blue' });
			expect(series.abortedMatches).toHaveLength(1);
			series.restart();
			expect(series.getResult().abortedMatches).toEqual([]);
		});

		it('ignores MatchDestroyed after the end, and drops a lobby closed before the match started', () => {
			const tracker = new MatchTracker();
			const match = new Match((event) => tracker.handle(event));
			const onAbort = vi.fn();
			const onEnd = vi.fn();
			tracker.onMatchAbort(onAbort);
			tracker.onMatchEnd(onEnd);

			match.start();
			match.play(3);
			match.end(0, [1, 0]);
			match.send(ev('MatchDestroyed'));
			expect(onEnd).toHaveBeenCalledOnce();
			expect(tracker).toMatchObject({ matchEnded: true, matchAborted: false });

			match.send(ev('MatchCreated'));
			match.frozen(2);
			match.send(ev('MatchDestroyed'));
			expect(tracker).toMatchObject({ matchInProgress: false, matchStarted: false, matchAborted: false });
			// Later UpdateState are not taken for a match joined midway.
			match.frozen(2);
			expect(tracker.matchStarted).toBe(false);

			// Left right after MatchInitialized, during the first kickoff countdown: nothing played, dropped too.
			match.send(ev('MatchCreated'));
			match.send(ev('MatchInitialized'));
			match.send(ev('CountdownBegin'));
			match.frozen(3);
			expect(tracker.matchStarted).toBe(true);
			match.send(ev('MatchDestroyed'));
			expect(tracker).toMatchObject({ matchStarted: false, matchAborted: false });
			match.frozen(2);
			expect(tracker.matchStarted).toBe(false);
			expect(onAbort).not.toHaveBeenCalled();
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

describe('EsportsSeries: team names, manual wins and snapshots', () => {
	function setup(options: EsportsSeriesOptions = {}) {
		const series = new EsportsSeries(undefined, options);
		const match = new Match((event) => series.tracker.handle(event));
		const playMatch = (winner: 0 | 1, score: [number, number]) => {
			match.players = [player('Ana', 0, { Score: 400 }), player('Bob', 1, { Score: 300 })];
			match.start();
			match.hit(winner, winner === 0 ? 1000 : -1000);
			match.play(10);
			match.end(winner, score);
		};
		return { series, match, playMatch };
	}

	it('names the teams with identifyTeam, and keeps each match with the names it was played with', () => {
		const sides: Record<number, string> = { 0: 'Karmine', 1: 'Vitality' };
		const { series, playMatch, match } = setup({ games: 5, identifyTeam: (team) => sides[team.TeamNum]! });
		playMatch(0, [2, 1]);
		// The teams switch sides for the next match.
		sides[0] = 'Vitality';
		sides[1] = 'Karmine';
		playMatch(0, [3, 0]);

		const result = series.getResult();
		// Same wins: Vitality first on goals (1 + 3 against 2 + 0).
		expect(result.teams.map((team) => [team.name, team.wins, team.goals])).toEqual([
			['Vitality', 1, 4],
			['Karmine', 1, 2],
		]);
		expect(result.matches[0]!.teamResults.map((team) => team.name)).toEqual(['Karmine', 'Vitality']);
		expect(result.players.find((p) => p.Name === 'Ana')!.team).toBe('Vitality');
		expect(series.teamOf(0)).toBe('Vitality');

		match.players = [player('Ana', 0), player('Bob', 1)];
		match.start();
		expect(series.tracker.teamNameOf(1)).toBe('Karmine');
		expect(series.tracker.getTeamResults().map((team) => team.name)).toEqual(['Vitality', 'Karmine']);
	});

	it('adds and removes wins by hand, and the series can end or go on with them', () => {
		const { series, playMatch } = setup({ games: 3 });
		const onEnd = vi.fn();
		const onUpdate = vi.fn();
		series.onSeriesEnd(onEnd);
		series.onUpdate(onUpdate);

		expect(series.adjustWins('Blue', 1)).toBe(1);
		expect(onUpdate).toHaveBeenCalledOnce();
		expect(series.getResult().teams).toMatchObject([{ name: 'Blue', wins: 1, manualWins: 1, matches: 0, winPercent: 0 }]);

		playMatch(0, [1, 0]);
		expect(series.status).toBe('finished');
		expect(onEnd).toHaveBeenCalledOnce();
		expect(series.getResult()).toMatchObject({ winner: 'Blue', manualWins: { Blue: 1 } });
		expect(series.getResult().teams[0]).toMatchObject({ wins: 2, winPercent: 100 });

		// Taking the manual win back: the series goes on.
		series.adjustWins(0, -1);
		expect(series.status).toBe('running');
		expect(series.winsOf('Blue')).toBe(1);
		// Wins never go below 0.
		expect(series.adjustWins('Orange', -3)).toBe(0);
		expect(series.setWins('Orange', 2)).toBe(2);
		expect(series.status).toBe('finished');
		expect(series.getResult().winner).toBe('Orange');
		expect(onEnd).toHaveBeenCalledTimes(2);

		series.restart();
		expect(series.getResult().teams).toEqual([]);
		expect(series.getResult().manualWins).toEqual({});
	});

	it('removes the last match', () => {
		const { series, playMatch } = setup({ games: 3 });
		playMatch(0, [1, 0]);
		playMatch(0, [2, 0]);
		expect(series.status).toBe('finished');
		expect(series.removeLastMatch()?.teams[0]?.Score).toBe(2);
		expect(series.status).toBe('running');
		expect(series.winsOf('Blue')).toBe(1);
		series.removeLastMatch();
		expect(series.removeLastMatch()).toBeUndefined();
	});

	it('restores a snapshot, also after JSON', () => {
		const { series, playMatch } = setup({ games: 5, timeouts: 1, timeoutSeconds: 60 });
		playMatch(0, [1, 0]);
		series.adjustWins('Orange', 1);
		series.callTimeout('Orange');
		const json = JSON.parse(JSON.stringify(series.snapshot()));

		const other = setup({ autoStart: false }).series;
		const onUpdate = vi.fn();
		other.onUpdate(onUpdate);
		other.restore(json);
		expect(onUpdate).toHaveBeenCalledOnce();
		expect(other.status).toBe('running');
		expect(other.getResult()).toMatchObject({ options: { games: 5, timeouts: 1 }, manualWins: { Orange: 1 } });
		expect(other.matches[0]!.endedAt).toBeInstanceOf(Date);
		expect(other.matches[0]!.endMoment.date).toBeInstanceOf(Date);
		expect(other.activeTimeout).toMatchObject({ team: 'Orange' });
		expect(other.activeTimeout!.endsAt).toBeInstanceOf(Date);
		expect(other.winsOf('Blue')).toBe(1);
		expect(other.winsOf('Orange')).toBe(1);
		expect(() => other.restore({} as never)).toThrow(TypeError);
		other.dispose();
		series.dispose();
	});

	it('ends a restored timeout whose time already ran out', () => {
		const { series, playMatch } = setup({ timeouts: 1, timeoutSeconds: 60 });
		playMatch(0, [1, 0]);
		series.callTimeout('Blue');
		const snapshot = series.snapshot();
		snapshot.timeouts[0]!.endsAt = new Date(Date.now() - 1000);
		const onEnd = vi.fn();
		const other = new EsportsSeries(undefined, { autoStart: false });
		other.onTimeoutEnd(onEnd);
		other.restore(snapshot);
		expect(other.activeTimeout).toBeUndefined();
		expect(onEnd.mock.calls[0]![0]).toMatchObject({ team: 'Blue', endReason: 'expired' });
		series.dispose();
	});
});

describe('EsportsSeries: options after the constructor and pause', () => {
	function setup(options: EsportsSeriesOptions = {}) {
		const series = new EsportsSeries(undefined, options);
		const match = new Match((event) => series.tracker.handle(event));
		const playMatch = (winner: 0 | 1) => {
			match.players = [player('Ana', 0), player('Bob', 1)];
			match.start();
			match.play(5);
			match.end(winner, winner === 0 ? [1, 0] : [0, 1]);
		};
		return { series, playMatch };
	}

	it('changes games and format without losing the matches', () => {
		const { series, playMatch } = setup({ games: 3 });
		const onEnd = vi.fn();
		const onUpdate = vi.fn();
		series.onSeriesEnd(onEnd);
		series.onUpdate(onUpdate);
		playMatch(0);
		playMatch(0);
		expect(series.status).toBe('finished');

		// Best of 3 to best of 5: the series goes on.
		expect(series.setGames(5)).toMatchObject({ games: 5, format: 'best-of' });
		expect(series.status).toBe('running');
		expect(series.matches).toHaveLength(2);
		expect(onUpdate).toHaveBeenCalled();
		playMatch(1);
		playMatch(0);
		expect(series.status).toBe('finished');
		expect(onEnd).toHaveBeenCalledTimes(2);

		series.setOptions({ format: 'play-all', games: 7 });
		expect(series.status).toBe('running');
		expect(series.options).toMatchObject({ games: 7, format: 'play-all' });
		expect(() => series.setGames(0)).toThrow(RangeError);
		expect(series.options.games).toBe(7);
	});

	it('changes the timeouts, also the one running', () => {
		const { series, playMatch } = setup({ games: 5 });
		playMatch(0);
		expect(series.timeoutRefusal('Blue')).toBe('disabled');
		series.setTimeouts(1, 60);
		const timeout = series.callTimeout('Blue');
		expect(timeout.endsAt!.getTime() - timeout.startedAt.getTime()).toBe(60_000);

		series.setTimeoutSeconds(120);
		expect(series.activeTimeout!.endsAt!.getTime() - timeout.startedAt.getTime()).toBe(120_000);
		series.setTimeoutSeconds(0);
		expect(series.activeTimeout!.endsAt).toBeUndefined();

		// Already used more than the new limit: none left, never negative.
		series.endTimeout();
		series.setTimeouts(0);
		expect(series.timeoutsLeft('Blue')).toBe(0);
		series.setTimeouts(2);
		expect(series.timeoutsLeft('Blue')).toBe(1);
	});

	it('ends a running timeout whose new length already passed', () => {
		vi.useFakeTimers();
		try {
			const { series, playMatch } = setup({ timeouts: 1, timeoutSeconds: 300 });
			playMatch(0);
			series.callTimeout('Blue');
			vi.advanceTimersByTime(90_000);
			series.setTimeoutSeconds(60);
			expect(series.activeTimeout).toBeUndefined();
			expect(series.getResult().timeouts[0]).toMatchObject({ endReason: 'expired' });
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not record matches while paused', () => {
		const { series, playMatch } = setup({ games: 3, timeouts: 1 });
		playMatch(0);
		expect(series.pause()).toBe(true);
		expect(series.pause()).toBe(false);
		expect(series.status).toBe('paused');
		expect(series.paused).toBe(true);
		expect(series.timeoutRefusal('Blue')).toBe('not-running');

		playMatch(1);
		playMatch(1);
		expect(series.matches).toHaveLength(1);
		// Manual wins still work while paused.
		series.adjustWins('Orange', 1);

		expect(series.resume()).toBe(true);
		expect(series.status).toBe('running');
		playMatch(0);
		expect(series.status).toBe('finished');
		expect(series.getResult().winner).toBe('Blue');

		const restored = new EsportsSeries(undefined, { autoStart: false });
		series.restart();
		series.pause();
		restored.restore(JSON.parse(JSON.stringify(series.snapshot())));
		expect(restored.status).toBe('paused');
		series.stop();
		expect(series.status).toBe('stopped');
	});
});

describe('what apps build on', () => {
	const game = (
		extra: Partial<Game> = {},
		{ guid = 'one' as string | undefined, players = [] as Player[] } = {},
	) => ev('UpdateState', { MatchGuid: guid, Players: players, Game: { ...baseGame, bReplay: false, ...extra } });
	const endScreen = { bHasWinner: true, bReplay: true, TimeSeconds: 0 };

	function context(options: EsportsSeriesOptions = {}) {
		const series = new EsportsSeries(undefined, options);
		const send = (...events: StatsApiEvent[]) => events.forEach((event) => series.tracker.handle(event));
		const play = (winner: 0 | 1, players: Player[] = [player('Ana', 0), player('Bob', 1)], names = ['Blue', 'Orange']) => {
			const Teams = names.map((Name, i) => ({ ...baseGame.Teams[0]!, TeamNum: i, Name, Score: i === winner ? 1 : 0 }));
			send(
				ev('MatchCreated'),
				ev('MatchInitialized'),
				ev('RoundStarted'),
				game({ Teams, TimeSeconds: 300 }, { players, guid: '' }),
				game({ Teams, TimeSeconds: 299 }, { players, guid: '' }),
				ev('MatchEnded', { WinnerTeamNum: winner }),
			);
		};
		return { series, tracker: series.tracker, send, play };
	}

	describe('wins by hand are counted net', () => {
		it('a corrected result reopens a best of 3', () => {
			const { series, play } = context({ games: 3 });
			play(0);
			play(0);
			expect(series.status).toBe('finished');
			series.adjustWins('Blue', -1);
			series.adjustWins('Orange', 1);
			expect(series.getResult()).toMatchObject({ status: 'running', matchesDecided: 2, winner: undefined });
		});

		it('also in the other order, and it can finish the series for the other team', () => {
			const { series, play } = context({ games: 3 });
			play(0);
			play(1);
			play(0);
			series.adjustWins('Orange', 1);
			series.adjustWins('Blue', -1);
			expect(series.getResult()).toMatchObject({ status: 'finished', winner: 'Orange', matchesDecided: 3 });
		});

		it('a forfeit still counts as a match', () => {
			const { series, play } = context({ games: 2, format: 'play-all' });
			play(0);
			series.adjustWins('Orange', 1);
			expect(series.getResult()).toMatchObject({ status: 'finished', matchesDecided: 2 });
		});
	});

	describe('joined on an end screen', () => {
		it('says it ended, without starting or recording anything', () => {
			const { series, tracker, send } = context();
			const onStart = vi.fn();
			const onEnd = vi.fn();
			tracker.onMatchStart(onStart);
			tracker.onMatchEnd(onEnd);
			send(game(endScreen), game(endScreen));
			expect(tracker).toMatchObject({ matchEnded: true, matchStarted: false, matchInProgress: false, phase: 'ended' });
			expect(onStart).not.toHaveBeenCalled();
			expect(onEnd).not.toHaveBeenCalled();
			expect(series.matches).toHaveLength(0);
		});

		it.each([
			['another guid', 'two'],
			['no guid', ''],
		])('the next match starts clean when its start was missed (%s)', (_case, guid) => {
			const { tracker, send } = context();
			send(game(endScreen, { guid: guid && 'one', players: [player('Old', 0)] }), game({}, { guid, players: [player('New', 0)] }));
			expect(tracker.matchStarted).toBe(true);
			expect(tracker.getPlayerResults().map((result) => result.Name)).toEqual(['New']);
		});

		it('also from RoundStarted, which stays in the timeline', () => {
			const { tracker, send } = context();
			send(game(endScreen, { players: [player('Old', 0)] }), ev('RoundStarted'));
			expect(tracker.matchStarted).toBe(true);
			expect(tracker.getPlayerResults()).toEqual([]);
			expect(tracker.getTimeline().map((entry) => entry.event.Event)).toEqual(['RoundStarted']);
		});

		it('the end screen of another match replaces it', () => {
			const { tracker, send } = context();
			send(game(endScreen, { players: [player('Old', 0)] }), game(endScreen, { guid: 'two', players: [player('New', 0)] }));
			expect(tracker.matchEnded).toBe(true);
			expect(tracker.getPlayerResults().map((result) => result.Name)).toEqual(['New']);
		});

		it('stays ended when its lobby is closed, also with updates still arriving', () => {
			const { tracker, send } = context();
			send(game(endScreen), ev('MatchDestroyed'));
			expect(tracker.phase).toBe('none');
			send(game());
			expect(tracker).toMatchObject({ matchStarted: false, matchEnded: true });
		});

		it('joined before MatchEnded (golden goal replay), that match is recorded', () => {
			const { series, send } = context();
			send(game({ bHasWinner: true, bReplay: true }), ev('MatchEnded', { WinnerTeamNum: 1 }));
			expect(series.matches.map((match) => match.winnerTeamNum)).toEqual([1]);
		});
	});

	describe('a missed end', () => {
		it('the next match starts clean, and what was played is kept as aborted', () => {
			const { series, tracker, send } = context();
			const old = { players: [player('Old', 0)] };
			send(ev('MatchInitialized'), ev('RoundStarted'), game({ TimeSeconds: 300 }, old), game({ TimeSeconds: 299 }, old));
			send(game({ TimeSeconds: 300 }, { guid: 'two', players: [player('New', 0)] }));
			expect(tracker.matchStarted).toBe(true);
			expect(tracker.getPlayerResults().map((result) => result.Name)).toEqual(['New']);
			expect(series.abortedMatches.map((match) => match.matchGuid)).toEqual(['one']);
		});

		it.each(['', undefined])('a packet without guid (%j) is the same match', (guid) => {
			const { series, tracker, send } = context();
			send(ev('MatchInitialized'), ev('RoundStarted'), game({ TimeSeconds: 300 }), game({ TimeSeconds: 299 }));
			send({ Event: 'UpdateState', Data: { MatchGuid: guid, Players: [], Game: { ...baseGame, TimeSeconds: 298 } } } as StatsApiEvent);
			send(game({ TimeSeconds: 297 }));
			expect(tracker.matchStarted).toBe(true);
			expect(series.abortedMatches).toEqual([]);
		});
	});

	// As seen in the game: a rematch in the same lobby keeps the MatchGuid.
	describe('matches one after another with the same MatchGuid', () => {
		const at = (TimeSeconds: number, score: number, extra: Partial<Game> = {}) =>
			game({ TimeSeconds, Teams: [{ ...baseGame.Teams[0]!, Score: score }], ...extra });
		const begin = [ev('MatchCreated'), ev('MatchInitialized'), ev('RoundStarted'), at(300, 0)];

		it.each([
			['regulation', at(0, 3, { bHasWinner: true, bReplay: true })],
			['overtime', at(40, 3, { bHasWinner: true, bReplay: true, bOvertime: true })],
		])('the next one starts when its start was missed, after %s', (_case, end) => {
			const { series, tracker, send } = context({ games: 1 });
			send(...begin, end, ev('MatchEnded', { WinnerTeamNum: 0 }), end);
			expect(series.status).toBe('finished');
			send(at(285, 0));
			expect(tracker.matchStarted).toBe(true);
			expect(series.status).toBe('running');
		});

		it('when the end was missed too, what was played is kept as aborted', () => {
			const { series, tracker, send } = context();
			send(...begin, at(299, 1), at(120, 2), at(119, 2), at(298, 0));
			expect(tracker).toMatchObject({ matchStarted: true });
			expect(series.abortedMatches).toHaveLength(1);
		});

		it('when the end was missed in overtime', () => {
			const { series, send } = context();
			send(...begin, at(299, 1), at(12, 2, { bOvertime: true }), at(280, 0));
			expect(series.abortedMatches).toHaveLength(1);
		});

		it('goals, goal replays, small steps of the clock and overtime are the same match', () => {
			const { series, send } = context();
			send(
				...begin,
				at(259, 1),
				at(259, 1, { bReplay: true }),
				at(259, 1),
				at(260, 1),
				at(100, 1),
				at(290, 1, { bReplay: true }),
				at(99, 1),
				at(0, 1),
				at(1, 1, { bOvertime: true }),
				at(90, 1, { bOvertime: true }),
			);
			expect(series.abortedMatches).toEqual([]);
			expect(series.tracker.matchStarted).toBe(true);
		});

		it('an end screen without the winner flag does not clear the result', () => {
			const { series, send } = context({ games: 1 });
			send(...begin, at(0, 3), ev('MatchEnded', { WinnerTeamNum: 0 }), at(0, 3), at(0, 3, { bReplay: true }));
			expect(series.status).toBe('finished');
		});

		it('the lobby after the old one was closed keeps the result, also before MatchCreated', () => {
			const { series, tracker, send } = context({ games: 1 });
			send(...begin, at(0, 3), ev('MatchEnded', { WinnerTeamNum: 0 }), ev('MatchDestroyed'), at(300, 0));
			send(game({}, { guid: 'another server' }));
			expect(series.status).toBe('finished');
			send(ev('RoundStarted'));
			expect(tracker.matchStarted).toBe(true);
			expect(series.status).toBe('running');
		});

		it('seeking back in a replay from the match history is not another match', () => {
			const { series, send } = context();
			send(ev('ReplayCreated', { FileName: 'a', Date: '' }), ...begin, at(120, 2), at(119, 2), at(280, 0));
			expect(series.abortedMatches).toEqual([]);
		});
	});

	describe('joined in a lobby', () => {
		const lobby = game({ TimeSeconds: 300, Teams: [{ ...baseGame.Teams[0]!, Score: 0 }] });

		it('is a lobby: a restored result stays', () => {
			const { series, play } = context({ games: 1 });
			play(0);
			const joined = context({ games: 1 });
			joined.series.restore(series.snapshot());
			joined.send(lobby, lobby);
			expect(joined.tracker).toMatchObject({ phase: 'lobby', matchStarted: false });
			expect(joined.series.status).toBe('finished');
		});

		it.each([
			['MatchInitialized', ev('MatchInitialized')],
			['RoundStarted', ev('RoundStarted')],
			['the clock moving', game({ TimeSeconds: 299, Teams: [{ ...baseGame.Teams[0]!, Score: 0 }] })],
		])('starts with %s', (_case, event) => {
			const { tracker, send } = context();
			send(lobby, event);
			expect(tracker.matchStarted).toBe(true);
		});
	});

	describe('phase', () => {
		it('follows a match from the lobby to the end', () => {
			const { tracker, send } = context();
			expect(tracker.phase).toBe('none');
			send(ev('MatchCreated'), game());
			expect(tracker.phase).toBe('lobby');
			send(ev('MatchInitialized'), game());
			expect(tracker.phase).toBe('playing');
			send(game({ bReplay: true }));
			expect(tracker.phase).toBe('replay');
			send(ev('MatchPaused'));
			expect(tracker.phase).toBe('paused');
			send(ev('MatchUnpaused'), ev('MatchEnded', { WinnerTeamNum: 0 }), game(endScreen));
			expect(tracker.phase).toBe('ended');
			send(ev('MatchDestroyed'));
			expect(tracker.phase).toBe('none');
			send(game(endScreen)); // the game can go on showing it
			expect(tracker.phase).toBe('ended');
		});

		it('is none after leaving a match', () => {
			const { tracker, send } = context();
			send(ev('MatchInitialized'), ev('RoundStarted'), game({ TimeSeconds: 300 }), game({ TimeSeconds: 299 }), ev('MatchDestroyed'));
			expect(tracker.phase).toBe('none');
		});

		it('setPaused pauses like the event', () => {
			const { tracker, send } = context();
			send(ev('MatchInitialized'), ev('RoundStarted'), game({ TimeSeconds: 300 }));
			tracker.setPaused(true);
			send(game({ TimeSeconds: 299 }));
			expect(tracker).toMatchObject({ phase: 'paused', paused: true });
			expect(tracker.getStats().secondsPlayed).toBe(0);
			tracker.setPaused(false);
			expect(tracker.phase).toBe('playing');
		});
	});

	it('a replay from the match history does not clear a finished series', () => {
		const { series, tracker, send, play } = context({ games: 1 });
		play(0);
		send(ev('MatchDestroyed'), ev('ReplayCreated', { FileName: 'a', Date: '' }), ev('MatchCreated'), ev('MatchInitialized'), game());
		expect(tracker.watchingReplay).toBe(true);
		expect(series.status).toBe('finished');
		send(ev('MatchDestroyed'), ev('MatchCreated'), ev('MatchInitialized'));
		expect(tracker.watchingReplay).toBe(false);
		expect(series.status).toBe('running');
	});

	describe('currentMatch', () => {
		it('is the match being played, the one just over on its end screen, then the next', () => {
			const { series, send, play } = context({ games: 3 });
			const current = () => series.getResult().currentMatch;
			expect(current()).toBe(1);
			play(0);
			expect(current()).toBe(1);
			send(ev('MatchDestroyed'));
			expect(current()).toBe(2);
			send(ev('MatchCreated'), ev('MatchInitialized'));
			expect(current()).toBe(2);
			send(game(), ev('MatchEnded', { WinnerTeamNum: 0 }), ev('MatchDestroyed'));
			expect(series.status).toBe('finished');
			expect(current()).toBe(2);
			send(ev('MatchCreated'), ev('MatchInitialized'));
			expect(current()).toBe(1);
		});

		it('counts the wins by hand', () => {
			const { series, play } = context();
			series.adjustWins('Orange', 1);
			expect(series.getResult().currentMatch).toBe(2);
			play(0);
			expect(series.getResult()).toMatchObject({ currentMatch: 2, matchesDecided: 2 });
		});

		it('a match that ended while paused is not counted', () => {
			const { series, play } = context();
			play(0);
			series.pause();
			play(0);
			expect(series.getResult()).toMatchObject({ currentMatch: 2, matchesDecided: 1 });
		});
	});

	describe('team totals of players', () => {
		const stats = { Score: 100, Assists: 2, Saves: 3, Demos: 4, Touches: 5, CarTouches: 6 };
		const totals = { score: 100, assists: 2, saves: 3, demos: 4, touches: 5, carTouches: 6, airTime: 0 };

		it('are in the results of the match and the series', () => {
			const { series, tracker, play } = context();
			play(0, [player('Ana', 0, stats)]);
			expect(tracker.getTeamResults()[0]).toMatchObject(totals);
			expect(series.matches[0]!.teamResults[0]).toMatchObject(totals);
			expect(series.getResult().teams.find((team) => team.name === 'Blue')).toMatchObject(totals);
		});

		it('a player who changed team counts for each team where they played', () => {
			const { series, play } = context();
			play(0, [player('Sub', 0, { Saves: 4 })]);
			play(0, [player('Sub', 1, { Saves: 1 })]);
			const saves = (name: string) => series.getResult().teams.find((team) => team.name === name)!.saves;
			expect([saves('Blue'), saves('Orange')]).toEqual([4, 1]);
		});

		it('are added to snapshots saved before they existed', () => {
			const { series, play } = context();
			play(0, [player('Ana', 0, stats)]);
			const saved = JSON.parse(JSON.stringify(series.snapshot()));
			for (const team of saved.matches[0].teamResults) for (const key of Object.keys(totals)) delete team[key];
			const restored = new EsportsSeries();
			restored.restore(saved);
			expect(restored.matches[0]!.teamResults[0]).toMatchObject(totals);
			expect(restored.getResult().teams.find((team) => team.name === 'Blue')).toMatchObject(totals);
		});
	});

	describe('renameTeams', () => {
		const played = () => {
			const made = context({ timeouts: 1, timeoutSeconds: 60 });
			made.play(0, [player('Ana', 0), player('Bob', 1)], ['A', 'B']);
			made.series.adjustWins('B', 1);
			made.series.callTimeout('A');
			return made;
		};

		it('exchanges two teams everywhere, at once', () => {
			const { series } = played();
			const onUpdate = vi.fn();
			series.onUpdate(onUpdate);
			series.renameTeams({ A: 'B', B: 'A' });
			expect(onUpdate).toHaveBeenCalledOnce();
			const [match] = series.matches;
			expect(match!.teamResults.map((team) => team.name)).toEqual(['B', 'A']);
			expect(match!.mvp).toMatchObject({ team: 'B', sessions: [{ team: 'B' }] });
			expect(series.getResult().manualWins).toEqual({ A: 1 });
			expect([series.winsOf('A'), series.winsOf('B')]).toEqual([1, 1]);
			expect(series.activeTimeout?.team).toBe('B');
			expect([series.timeoutsLeft('A'), series.timeoutsLeft('B')]).toEqual([1, 0]);
			expect(series.endTimeout()).toMatchObject({ team: 'B', endReason: 'ended' });
			expect(series.getResult().timeouts[0]).toMatchObject({ team: 'B', endReason: 'ended' });
		});

		it('takes a Map, and does nothing without changes', () => {
			const { series } = played();
			const onUpdate = vi.fn();
			series.onUpdate(onUpdate);
			series.renameTeams(new Map([['A', 'A']]));
			expect(onUpdate).not.toHaveBeenCalled();
			series.renameTeams(new Map([['A', 'C']]));
			expect(series.winsOf('C')).toBe(1);
			series.dispose();
		});

		it('leaves results given before, and snapshots, as they were', () => {
			const { series } = played();
			const before = series.getResult();
			const snapshot = series.snapshot();
			const copy = renameSnapshotTeams(snapshot, { A: 'C' });
			series.renameTeams({ A: 'D' });
			expect(before.matches[0]!.teamResults[0]!.name).toBe('A');
			expect(snapshot.matches[0]!.teamResults[0]!.name).toBe('A');
			expect(copy.matches[0]!.teamResults[0]!.name).toBe('C');
			series.dispose();
		});

		it('two teams renamed to one name become one', () => {
			const { series } = played();
			series.renameTeams({ B: 'A' });
			expect(series.winsOf('A')).toBe(2);
			series.dispose();
		});

		it('renames matches stored without team results', () => {
			const { series } = played();
			const saved = series.snapshot();
			(saved.matches[0] as { teamResults?: unknown }).teamResults = undefined;
			series.restore(saved);
			series.renameTeams({ A: 'C' });
			expect(series.winsOf('C')).toBe(1);
			series.dispose();
		});
	});

	it('snapshot({ timeline: false }) leaves out the timelines, not the results', () => {
		const { series, play } = context();
		play(0);
		const small = series.snapshot({ timeline: false });
		expect(small.matches[0]!.timeline).toEqual([]);
		expect(series.matches[0]!.timeline.length).toBeGreaterThan(0);
		expect(series.snapshot().matches[0]!.timeline.length).toBeGreaterThan(0);
		const restored = new EsportsSeries();
		restored.restore(small);
		expect(restored.getResult().teams).toEqual(series.getResult().teams);
	});

	it('EventRelay outlives the sources it forwards', () => {
		const relay = new EventRelay();
		const tracker = new MatchTracker(relay);
		const first = new EventRelay();
		const second = new EventRelay();
		const stop = relay.forward(first);
		first.emit(ev('MatchInitialized'));
		expect(tracker.matchStarted).toBe(true);
		stop();
		first.emit(ev('MatchEnded', { WinnerTeamNum: 0 }));
		expect(tracker.matchEnded).toBe(false);
		relay.forward(second);
		second.emit(ev('MatchEnded', { WinnerTeamNum: 0 }));
		expect(tracker.matchEnded).toBe(true);
	});
});

describe('a mirror of a series', () => {
	const ended = (series: EsportsSeries) => {
		const match = new Match((event) => series.tracker.handle(event));
		match.start();
		match.play(3);
		match.end(0, [1, 0]);
	};

	it('counts a match once, whether the snapshot comes before or after the end', () => {
		const source = new EsportsSeries();
		ended(source);
		const first = new EsportsSeries(undefined, { mirror: true });
		first.restore(source.snapshot());
		ended(first);
		expect(first.winsOf('Blue')).toBe(1);

		const second = new EsportsSeries(undefined, { mirror: true });
		second.restore(new EsportsSeries().snapshot());
		ended(second);
		expect(second.matches).toHaveLength(0);
		second.restore(source.snapshot());
		expect(second.winsOf('Blue')).toBe(1);
	});

	it('never starts by itself, and still has the live match', () => {
		const series = new EsportsSeries(undefined, { mirror: true, autoStart: true });
		expect(series.autoStart).toBe(false);
		expect(series.status).toBe('idle');
		series.restore(new EsportsSeries().snapshot());
		const match = new Match((event) => series.tracker.handle(event));
		match.start();
		match.play(3);
		expect(series.getLiveResult().teams.find((team) => team.name === 'Blue')?.matches).toBe(1);
		match.send(ev('MatchDestroyed'));
		expect(series.abortedMatches).toEqual([]);
	});
});
