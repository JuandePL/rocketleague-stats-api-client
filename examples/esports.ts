/**
 * Records a best-of-5 series and prints the stats of each match.
 *
 * Run with: npx tsx examples/esports.ts
 * Requires Rocket League running with the Stats API enabled (see README).
 * Spectate the matches to get boost usage (the Boost field is only sent to spectators).
 */
import { EsportsSeries, RocketLeagueStatsClient } from '../src/index.js';

const client = new RocketLeagueStatsClient();
const series = new EsportsSeries(client);

const pct = (value: number) => `${value.toFixed(0)}%`;

client.on('connect', () => {
	console.log('Connected. Recording a best of 5. Type "r" + Enter to restart, "s" + Enter to stop.');
	series.start({ games: 5 });
});

series.onMatchEnd((match, result) => {
	const [blue, orange] = match.teams;
	console.log(`\nGame ${result.matches.length}: ${blue?.Name} ${blue?.Score} - ${orange?.Score} ${orange?.Name}`);
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

process.stdin.on('data', (input) => {
	const command = input.toString().trim();
	if (command === 'r') {
		series.restart();
		console.log('Series restarted.');
	} else if (command === 's') {
		series.stop();
		console.log('Series stopped.', series.getResult().teams);
	}
});
