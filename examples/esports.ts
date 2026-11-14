/**
 * Records a series (best of 5 by default) and prints the stats of each match.
 *
 * Run with:
 *   npx tsx examples/esports.ts               best of 5
 *   npx tsx examples/esports.ts 7             best of 7
 *   npx tsx examples/esports.ts 3 --play-all  play all 3 matches, even if one team already won 2
 *
 * While running, type a command and press Enter:
 *   bo <N>    start a new best of N (e.g. "bo 3"). Clears the current series.
 *   all <N>   start a new series where all N matches are played.
 *   r         restart the series with the same settings.
 *   s         stop the series and show the results so far.
 *
 * Requires Rocket League running with the Stats API enabled (see README).
 * Spectate the matches to get boost usage (the Boost field is only sent to spectators).
 */
import { createInterface } from 'node:readline';
import { EsportsSeries, RocketLeagueStatsClient, type SeriesOptions } from '../src/index.js';

/** Reads the series settings from the command line. */
function parseArgs(args: string[]): SeriesOptions {
	const games = Number(args.find((arg) => !arg.startsWith('--')) ?? 5);
	if (!Number.isInteger(games) || games < 1) {
		console.error(`Invalid number of games: "${games}". Use a positive integer, e.g. 5.`);
		process.exit(1);
	}
	return { games, format: args.includes('--play-all') ? 'play-all' : 'best-of' };
}

const describe = ({ games, format }: SeriesOptions) =>
	format === 'play-all' ? `${games} matches (all played)` : `best of ${games} (first to ${Math.floor(games / 2) + 1})`;

const options = parseArgs(process.argv.slice(2));

const client = new RocketLeagueStatsClient();
const series = new EsportsSeries(client);

const pct = (value: number) => `${value.toFixed(0)}%`;

client.on('connect', () => {
	// Only on the first connection: a reconnect must not wipe the series in progress.
	if (series.status !== 'idle') return console.log(`Connected. The current series continues: ${describe(series.getResult().options)}.`);
	series.start(options);
	console.log(`Connected. Recording: ${describe(options)}. Commands: "bo <N>", "all <N>", "r", "s".`);
});

series.onMatchEnd((match, result) => {
	const [blue, orange] = match.teams;
	const overtime = match.overtime ? ' (OT)' : '';
	console.log(`\nGame ${result.matches.length}: ${blue?.Name} ${blue?.Score} - ${orange?.Score} ${orange?.Name}${overtime}`);
	console.log(`  Time played: ${Math.round(match.secondsPlayed)} s`);
	console.log(`  MVP: ${match.mvp?.Name ?? '-'}`);
	console.log(`  Possession: blue ${pct(match.possession.percent.blue)} / orange ${pct(match.possession.percent.orange)}`);
	console.log(`  Pressure:   blue ${pct(match.fieldDomination.pressure.blue)} / orange ${pct(match.fieldDomination.pressure.orange)}`);
	console.log(`  Boost used: blue ${match.boost.teams.blue.toFixed(0)} / orange ${match.boost.teams.orange.toFixed(0)}`);
	console.log(`  Series: ${result.teams.map((team) => `${team.name} ${team.wins}`).join(' - ')}`);
});

series.onSeriesEnd((result) => {
	console.log(`\n${result.winner ?? 'Nobody'} wins the series. Series MVP: ${result.mvp?.Name ?? '-'}`);
	for (const player of result.players) {
		console.log(`  ${player.Name} (${player.team}): ${player.Score} pts, ${player.Goals} goals, ${player.mvps} MVPs`);
	}
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
			const next: SeriesOptions = { games, format: command === 'all' ? 'play-all' : 'best-of' };
			series.start(next);
			console.log(`New series: ${describe(next)}.`);
			return;
		}
		case 'r':
			series.restart();
			console.log(`Series restarted: ${describe(series.getResult().options)}.`);
			return;
		case 's':
			series.stop();
			console.log('Series stopped.', series.getResult().teams);
			return;
		default:
			if (command) console.log('Commands: "bo <N>", "all <N>", "r", "s".');
	}
});
