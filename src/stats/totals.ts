// Not exported by the package: the team results have these totals.
import type { MatchPlayerResult, TeamPlayerTotals } from './match.js';

/** Sums what a team result has of its players. */
export function teamPlayerTotals(players: readonly MatchPlayerResult[]): TeamPlayerTotals {
	const totals: TeamPlayerTotals = { score: 0, assists: 0, saves: 0, demos: 0, touches: 0, carTouches: 0, airTime: 0 };
	for (const player of players) {
		totals.score += player.Score;
		totals.assists += player.Assists;
		totals.saves += player.Saves;
		totals.demos += player.Demos;
		totals.touches += player.Touches;
		totals.carTouches += player.CarTouches;
		totals.airTime += player.airTime;
	}
	return totals;
}
