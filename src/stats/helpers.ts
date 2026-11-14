import { byStat, sortPlayers, type PlayerStat } from '../sort.js';
import { Team, type Player, type PlayerRef, type TeamNum } from '../types/common.js';

/** A value per team. */
export interface TeamSplit {
	blue: number;
	orange: number;
}

/** Scoreboard stats summed for one team. */
export interface TeamTotals {
	/** Number of players in the team. */
	players: number;
	Score: number;
	Goals: number;
	Shots: number;
	Assists: number;
	Saves: number;
	Touches: number;
	CarTouches: number;
	Demos: number;
}

/** Scoreboard stats summed by {@link getTeamTotals}. */
export const TOTAL_STATS = ['Score', 'Goals', 'Shots', 'Assists', 'Saves', 'Touches', 'CarTouches', 'Demos'] as const;

/**
 * Stable identifier for a player across ticks and matches: `PrimaryId` plus the name,
 * so bots and splitscreen players that share a `PrimaryId` stay apart.
 */
export function playerKey(player: PlayerRef & { PrimaryId?: string }): string {
	return `${player.PrimaryId ?? ''}:${player.Name}`;
}

/** Maps a `TeamNum` to `'blue'` / `'orange'`, or `undefined` for any other value (e.g. `255`). */
export function teamSide(teamNum: TeamNum): keyof TeamSplit | undefined {
	return teamNum === Team.Blue ? 'blue' : teamNum === Team.Orange ? 'orange' : undefined;
}

/** Name of the team that plays as `teamNum`, from `Game.Teams`. Falls back to `Blue` / `Orange`. */
export function teamName(teams: readonly { TeamNum: TeamNum; Name: string }[], teamNum: TeamNum): string {
	const name = teams.find((team) => team.TeamNum === teamNum)?.Name;
	return name || (teamNum === Team.Blue ? 'Blue' : teamNum === Team.Orange ? 'Orange' : `Team ${teamNum}`);
}

/** Converts a split into percentages (0–100) of its total. Both are `0` when the total is `0`. */
export function toPercent(split: TeamSplit): TeamSplit {
	const total = split.blue + split.orange;
	return total > 0 ? { blue: (split.blue / total) * 100, orange: (split.orange / total) * 100 } : { blue: 0, orange: 0 };
}

/**
 * The player with the highest value of `stat`, or `undefined` for an empty list.
 * Ties keep the first player in the list.
 */
export function getTopPlayer(players: readonly Player[], stat: PlayerStat): Player | undefined {
	return sortPlayers(players, byStat(stat))[0];
}

/**
 * The match MVP: the player with the highest `Score` on the winning team, like the game does.
 * Ties are broken by goals, assists, saves and shots. Without `winnerTeamNum`, every player is considered.
 */
export function getMvp(players: readonly Player[], winnerTeamNum?: TeamNum): Player | undefined {
	const winners = winnerTeamNum === undefined ? [] : players.filter((p) => p.TeamNum === winnerTeamNum);
	const candidates = winners.length > 0 ? winners : players;
	return sortPlayers(candidates, byStat('Score'), byStat('Goals'), byStat('Assists'), byStat('Saves'), byStat('Shots'))[0];
}

/** Sums the scoreboard stats of each team. */
export function getTeamTotals(players: readonly Player[]): { blue: TeamTotals; orange: TeamTotals } {
	const empty = (): TeamTotals => ({ players: 0, Score: 0, Goals: 0, Shots: 0, Assists: 0, Saves: 0, Touches: 0, CarTouches: 0, Demos: 0 });
	const totals = { blue: empty(), orange: empty() };
	for (const player of players) {
		const side = teamSide(player.TeamNum);
		if (!side) continue;
		const team = totals[side];
		team.players++;
		for (const stat of TOTAL_STATS) team[stat] += player[stat] ?? 0;
	}
	return totals;
}
