/**
 * Records series of matches (best of 5 by default) and prints the stats of each match and of each player.
 * Recording starts by itself, and a new series starts by itself after one ends.
 *
 * Run with:
 *   npx tsx examples/esports.ts                 best of 5
 *   npx tsx examples/esports.ts 7               best of 7
 *   npx tsx examples/esports.ts 3 --play-all    play all 3 matches, even if one team already won 2
 *   npx tsx examples/esports.ts --manual        don't start series by yourself: use the commands below
 *
 * While running, type a command and press Enter:
 *   bo <N>    start a new best of N (e.g. "bo 3"). Clears the current series.
 *   all <N>   start a new series where all N matches are played.
 *   r         restart the series with the same settings.
 *   s         stop the series and show the results so far (no automatic restart until "r" or "bo").
 *
 * Requires Rocket League running with the Stats API enabled (see README).
 * Spectate the matches to get boost usage and air time (those fields are only sent to spectators).
 */
import { createInterface } from 'node:readline';
import {
	EsportsSeries,
	RocketLeagueStatsClient,
	type MatchPlayerResult,
	type SeriesOptions,
	type SeriesPlayerResult,
} from '../src/index.js';

/** Reads the series settings from the command line. */
function parseArgs(args: string[]): SeriesOptions & { autoStart: boolean } {
	const games = Number(args.find((arg) => !arg.startsWith('--')) ?? 5);
	if (!Number.isInteger(games) || games < 1) {
		console.error(`Invalid number of games: "${games}". Use a positive integer, e.g. 5.`);
		process.exit(1);
	}
	return { games, format: args.includes('--play-all') ? 'play-all' : 'best-of', autoStart: !args.includes('--manual') };
}

const describe = ({ games, format }: SeriesOptions) =>
	format === 'play-all' ? `${games} matches (all played)` : `best of ${games} (first to ${Math.floor(games / 2) + 1})`;

const pct = (value: number) => `${value.toFixed(0)}%`;
const secs = (value: number) => `${value.toFixed(1)} s`;

/** One line per player: scoreboard, boost, air time and crossbar hits. */
function printPlayer(player: MatchPlayerResult | SeriesPlayerResult, extra = ''): void {
	const { attack, defense } = player.crossbar;
	console.log(
		`    ${player.Name.padEnd(16)} ${player.team.padEnd(10)} ` +
			`${String(player.Score).padStart(4)} pts  G ${player.Goals}  A ${player.Assists}  Sv ${player.Saves}  Sh ${player.Shots}  ` +
			`boost ${player.boostUsed.toFixed(0)}  air ${secs(player.airTime)}  posts ${attack} att / ${defense} def${extra}`,
	);
}

const options = parseArgs(process.argv.slice(2));

const client = new RocketLeagueStatsClient();
// With autoStart (default), the series records right away and starts again after it ends: no start() needed.
const series = new EsportsSeries(client, options);

client.on('connect', () => {
	const state = series.status === 'idle' ? 'waiting for "bo <N>" or "all <N>"' : `recording ${describe(series.getResult().options)}`;
	console.log(`Connected, ${state}. Commands: "bo <N>", "all <N>", "r", "s".`);
});

series.onSeriesStart((settings) => console.log(`\n=== New series: ${describe(settings)} ===`));

series.onMatchEnd((match, result) => {
	const [blue, orange] = match.teams;
	const overtime = match.overtime ? ' (OT)' : '';
	console.log(`\nGame ${result.matches.length}: ${blue?.Name} ${blue?.Score} - ${orange?.Score} ${orange?.Name}${overtime}`);
	console.log(`  Time played: ${Math.round(match.secondsPlayed)} s   MVP: ${match.mvp?.Name ?? '-'}`);
	console.log(`  Possession: blue ${pct(match.possession.percent.blue)} / orange ${pct(match.possession.percent.orange)}`);
	console.log(`  Pressure:   blue ${pct(match.fieldDomination.pressure.blue)} / orange ${pct(match.fieldDomination.pressure.orange)}`);
	console.log(`  Boost used: blue ${match.boost.teams.blue.toFixed(0)} / orange ${match.boost.teams.orange.toFixed(0)}`);
	console.log('  Players:');
	for (const player of match.playerResults) printPlayer(player, player.mvp ? '  MVP' : '');
	console.log(`  Series: ${result.teams.map((team) => `${team.name} ${team.wins}`).join(' - ')}`);
});

series.onSeriesEnd((result) => {
	console.log(`\n${result.winner ?? 'Nobody'} wins the series. Series MVP: ${result.mvp?.Name ?? '-'}`);
	console.log('  Players (whole series):');
	for (const player of result.players) printPlayer(player, `  ${player.matches} games, ${player.mvps} MVPs`);
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
			series.start({ games, format: command === 'all' ? 'play-all' : 'best-of' }); // prints "New series"
			return;
		}
		case 'r':
			series.restart();
			return;
		case 's': {
			series.stop();
			const result = series.getResult();
			console.log(`Series stopped after ${result.matches.length} games. ${result.teams.map((t) => `${t.name} ${t.wins}`).join(' - ')}`);
			for (const player of result.players) printPlayer(player, `  ${player.matches} games, ${player.mvps} MVPs`);
			return;
		}
		default:
			if (command) console.log('Commands: "bo <N>", "all <N>", "r", "s".');
	}
});
