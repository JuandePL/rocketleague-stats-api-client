/**
 * Records series of matches (best of 5 by default) and prints the stats of each match and of each player.
 * Recording starts by itself, and a new series starts by itself after one ends.
 *
 * Run with:
 *   npx tsx examples/esports.ts                 best of 5
 *   npx tsx examples/esports.ts 7               best of 7
 *   npx tsx examples/esports.ts 3 --play-all    play all 3 matches, even if one team already won 2
 *   npx tsx examples/esports.ts --manual        don't start series by yourself: use the commands below
 *   npx tsx examples/esports.ts --timeouts 1 --timeout-seconds 300
 *                                               one 5-minute timeout per team and series (0 seconds = no limit)
 *
 * While running, type a command and press Enter:
 *   bo <N>    start a new best of N (e.g. "bo 3"). Clears the current series.
 *   all <N>   start a new series where all N matches are played.
 *   r         restart the series with the same settings.
 *   s         stop the series and show the results so far (no automatic restart until "r" or "bo").
 *   l         show the live series totals, including the match being played.
 *   t <team>  the team calls a timeout, by name ("t Orange") or by TeamNum in the last match ("t 1").
 *             Between matches, the lobby included. It ends when its time runs out or the next match starts (MatchInitialized).
 *             A number is always read as a TeamNum, even if a team is named "123".
 *   te        end the running timeout (the team is ready).
 *
 * Requires Rocket League running with the Stats API enabled (see README).
 * Spectate the matches to get boost usage, speed and air time (those fields are only sent to spectators).
 */
import { createInterface } from 'node:readline';
import {
	EsportsSeries,
	RocketLeagueStatsClient,
	type MatchPlayerResult,
	type SeriesOptions,
	type SeriesPlayerResult,
	SeriesTimeoutError,
	timeFromPlayerLeftToMatchEnd,
	timeFromPlayerLeftToNextGoal,
} from '../src/index.js';

/** Reads the series settings from the command line. */
function parseArgs(args: string[]): SeriesOptions & { autoStart: boolean } {
	/** Value after `--name`, as a non-negative number. */
	const flag = (name: string): number => {
		const index = args.indexOf(name);
		if (index === -1) return 0;
		const value = Number(args[index + 1]);
		if (!Number.isFinite(value) || value < 0) {
			console.error(`Invalid value for ${name}: "${args[index + 1]}". Use a number of 0 or more.`);
			process.exit(1);
		}
		return value;
	};
	// The number of games is the first argument that is not a flag nor the value of one.
	const games = Number(args.find((arg, i) => !arg.startsWith('--') && !args[i - 1]?.startsWith('--timeout')) ?? 5);
	if (!Number.isInteger(games) || games < 1) {
		console.error(`Invalid number of games: "${games}". Use a positive integer, e.g. 5.`);
		process.exit(1);
	}
	return {
		games,
		format: args.includes('--play-all') ? 'play-all' : 'best-of',
		autoStart: !args.includes('--manual'),
		timeouts: flag('--timeouts'),
		timeoutSeconds: flag('--timeout-seconds'),
	};
}

const describe = ({ games, format, timeouts = 0, timeoutSeconds = 0 }: SeriesOptions) => {
	const kind = format === 'play-all' ? `${games} matches (all played)` : `best of ${games} (first to ${Math.floor(games / 2) + 1})`;
	if (timeouts === 0) return kind;
	return `${kind}, ${timeouts} timeout(s) per team${timeoutSeconds > 0 ? ` of ${timeoutSeconds} s` : ''}`;
};

const COMMANDS = 'Commands: "bo <N>", "all <N>", "r", "s", "l", "t <team>", "te".';

const pct = (value: number) => `${value.toFixed(0)}%`;
const secs = (value: number) => `${value.toFixed(1)} s`;
const kmh = (speed: number) => `${speed.toFixed(0)} km/h`; // the game sends speeds in km/h

/** One line per player: scoreboard, boost, air time, speed and crossbar hits. */
function printPlayer(player: MatchPlayerResult | SeriesPlayerResult, extra = ''): void {
	const { attack, defense } = player.crossbar;
	console.log(
		`    ${player.Name.padEnd(16)} ${player.team.padEnd(10)} ` +
			`${String(player.Score).padStart(4)} pts  G ${player.Goals}  A ${player.Assists}  Sv ${player.Saves}  Sh ${player.Shots}  ` +
			`boost ${player.boostUsed.toFixed(0)}  air ${secs(player.airTime)}  wall ${secs(player.onWallTime)}  speed ${kmh(player.averageSpeed)}  posts ${attack} att / ${defense} def${extra}`,
	);
}

/** "Orange 05:00-04:50, Orange 04:44-end": when the player was in the match and on which team. */
function describeSessions(player: MatchPlayerResult): string {
	const sessions = player.sessions.map((s) => `${s.team} ${s.joinedAt.clock}-${s.leftAt ? s.leftAt.clock : 'end'}`);
	return `${sessions.join(', ')} (left ${player.leaves}x)`;
}

/** Games, MVPs, matches left early and platform id of a player over the series. */
function seriesExtra(player: SeriesPlayerResult): string {
	const left = player.leaves > 0 ? `, left ${player.leaves}x (${player.leftEarly} games not finished)` : '';
	const id = player.bot ? 'bot' : player.PrimaryId;
	const aka = player.names.length > 1 ? `, also ${player.names.filter((name) => name !== player.Name).join(', ')}` : '';
	return `  ${player.matches} games, ${player.mvps} MVPs${left}  [${id}${aka}]`;
}

const options = parseArgs(process.argv.slice(2));

const client = new RocketLeagueStatsClient();
// With autoStart (default), the series records right away and starts again after it ends: no start() needed.
const series = new EsportsSeries(client, options);

client.on('connect', () => {
	const state = series.status === 'idle' ? 'waiting for "bo <N>" or "all <N>"' : `recording ${describe(series.getResult().options)}`;
	console.log(`Connected, ${state}. ${COMMANDS}`);
});

series.onSeriesStart((settings) => console.log(`\n=== New series: ${describe(settings)} ===`));

series.onMatchEnd((match, result) => {
	const [blue, orange] = match.teams;
	const overtime = match.overtime ? ' (OT)' : '';
	console.log(`\nGame ${result.matches.length}: ${blue?.Name} ${blue?.Score} - ${orange?.Score} ${orange?.Name}${overtime}`);
	console.log(`  Time played: ${Math.round(match.secondsPlayed)} s   MVP: ${match.mvp?.Name ?? '-'}`);
	console.log(`  Possession: blue ${pct(match.possession.percent.blue)} / orange ${pct(match.possession.percent.orange)}`);
	console.log(`  Boost used: blue ${match.boost.teams.blue.toFixed(0)} / orange ${match.boost.teams.orange.toFixed(0)}`);
	console.log('  Players:');
	for (const player of match.playerResults) {
		let left = '';
		if (player.leftAt) {
			const toEnd = timeFromPlayerLeftToMatchEnd(match, player);
			const toGoal = timeFromPlayerLeftToNextGoal(match, player);
			left = `  LEFT at ${player.leftAt.clock}, ${Math.round(toEnd?.clockSeconds ?? 0)} s before the end`;
			left += toGoal ? `, ${Math.round(toGoal.clockSeconds)} s before the next goal` : ', no goal after';
		}
		printPlayer(player, player.mvp ? '  MVP' : left);
		if (player.sessions.length > 1) console.log(`      in and out: ${describeSessions(player)}`);
	}
	console.log(`  Series: ${result.teams.map((team) => `${team.name} ${team.wins}`).join(' - ')}`);
	if (result.options.timeouts > 0 && result.status === 'running') {
		console.log(`  Timeouts left: ${result.teams.map((team) => `${team.name} ${team.timeoutsLeft}`).join(', ')} ("t <team>" to call one)`);
	}
});

series.onTimeoutStart((timeout) => {
	const until = timeout.endsAt ? ` until ${timeout.endsAt.toLocaleTimeString()}` : ' ("te" to end it)';
	console.log(`\n>>> Timeout for ${timeout.team} after game ${timeout.afterMatch}${until}. ${series.timeoutsLeft(timeout.team)} left.`);
});

series.onTimeoutEnd((timeout) => {
	const reasons = { ended: 'ended', expired: 'time is up', 'match-started': 'the next match started', cancelled: 'cancelled' } as const;
	const seconds = Math.round((timeout.endedAt!.getTime() - timeout.startedAt.getTime()) / 1000);
	console.log(`<<< Timeout of ${timeout.team} over after ${seconds} s: ${reasons[timeout.endReason!]}.`);
});

series.onMatchAbort((match, result) => {
	const [blue, orange] = match.teams;
	console.log(`\nGame left before the end at ${blue?.Name} ${blue?.Score} - ${orange?.Score} ${orange?.Name} (${Math.round(match.secondsPlayed)} s played).`);
	console.log(`  It doesn't count: still ${result.matches.length} games played. ${result.abortedMatches.length} abandoned so far in this series.`);
});

series.onSeriesEnd((result) => {
	console.log(`\n${result.winner ?? 'Nobody'} wins the series. Series MVP: ${result.mvp?.Name ?? '-'}`);
	console.log('  Players (whole series):');
	for (const player of result.players) printPlayer(player, seriesExtra(player));
	if (series.autoStart) console.log('  A new series starts with the next match.');
});

createInterface({ input: process.stdin }).on('line', (line) => {
	const [command, value] = line.trim().split(/\s+/);
	switch (command) {
		case 'bo':
		case 'all': {
			const games = Number(value);
			if (!Number.isInteger(games) || games < 1) {
				console.log(`Usage: ${command} <N>, with N a positive integer (e.g. "${command} 5").`);
				return;
			}
			// Keep the timeout settings of the command line.
			series.start({ ...series.getResult().options, games, format: command === 'all' ? 'play-all' : 'best-of' }); // prints "New series"
			return;
		}
		case 'r':
			series.restart();
			return;
		case 's': {
			series.stop();
			const result = series.getResult();
			console.log(`Series stopped after ${result.matches.length} games. ${result.teams.map((t) => `${t.name} ${t.wins}`).join(' - ')}`);
			for (const player of result.players) printPlayer(player, seriesExtra(player));
			return;
		}
		case 'l': {
			const live = series.getLiveResult();
			const playing = series.tracker.matchStarted ? ', match in progress included' : '';
			console.log(`Live: ${live.matches.length} games finished${playing}. ${live.teams.map((t) => `${t.name} ${t.wins}`).join(' - ')}`);
			for (const player of live.players) printPlayer(player, seriesExtra(player));
			return;
		}
		case 't': {
			if (!value) {
				console.log('Usage: t <team>, with the team name or its TeamNum in the last match (0 blue, 1 orange).');
				return;
			}
			// A number is a TeamNum, anything else a team name (which can have spaces). A team named only with
			// digits ("123") is read as a TeamNum, so call it by TeamNum instead.
			const team = /^\d+$/.test(value) ? Number(value) : line.trim().slice(1).trim();
			try {
				series.callTimeout(team); // printed by onTimeoutStart
			} catch (error) {
				if (!(error instanceof SeriesTimeoutError)) throw error;
				console.log(`No timeout for ${series.teamOf(team)}: ${error.reason}.`);
			}
			return;
		}
		case 'te':
			if (!series.endTimeout()) console.log('No timeout is running.');
			return;
		default:
			if (command) console.log(COMMANDS);
	}
});
