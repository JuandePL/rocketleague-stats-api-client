# Esports mode: `EsportsSeries`

[← Docs index](README.md) · [README](../README.md)

Records series of matches in memory and gives you the results. By default it records on its own: the series starts right away, and a new one starts after each series ends. Each match is tracked with a [`MatchTracker`](match-stats.md#matchtracker), available as `series.tracker`.

## Contents

- [Usage](#usage)
- [API](#api)
- [How teams and players are identified](#how-teams-and-players-are-identified)
- [What the results include](#what-the-results-include)
- [Which matches count](#which-matches-count)
- [Timeouts](#timeouts)

## Usage

```ts
import { EsportsSeries } from '@juande_pl/rocketleague-stats-api-client';

const series = new EsportsSeries(client);                    // best of 5, recording right away
const bo7 = new EsportsSeries(client, { games: 7 });         // best of 7
const manual = new EsportsSeries(client, { autoStart: false }); // nothing is recorded until start()

series.onSeriesStart((options) => console.log(`New series: best of ${options.games}`));
series.onMatchEnd((match, result) => console.log(`Game ${result.matches.length}: MVP ${match.mvp?.Name}`));
series.onSeriesEnd((result) => console.log(`${result.winner} wins the series. MVP: ${result.mvp?.Name}`));

series.start({ games: 5 });                       // best of 5: ends when a team wins 3
series.start({ games: 3, format: 'play-all' });   // plays all 3 matches
series.stop();                                    // stops recording, keeps the results
series.restart();                                 // same options, clears the stored matches
series.getResult();                               // standings at any time (check `finished`)
series.getLiveResult();                           // the same, also counting the match being played
series.tracker.getStats();                        // live stats of the current match
```

See also [examples/esports.ts](../examples/esports.ts).

## API

| Method / property      | Description                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `new EsportsSeries(client, { games, format, autoStart, timeouts, timeoutSeconds })` | `games` defaults to `5`, `format` to `'best-of'`, `autoStart` to `true`, `timeouts` and `timeoutSeconds` to `0`. |
| `start({ games, format, timeouts, timeoutSeconds })` | Starts a series. Clears any stored matches. `format`: `'best-of'` (default) or `'play-all'`. |
| `restart()`            | Starts again with the same options. Clears the stored matches.                                |
| `stop()`               | Stops recording, and the automatic restart until the next `start()` or `restart()`. The matches played so far stay in `getResult()`. |
| `getResult()`          | `{ status, finished, matches, teams, winner, players, mvp, timeouts, activeTimeout }`, with the finished matches.      |
| `getLiveResult()`      | Like `getResult()`, but team and player totals also include the match being played (no win until it ends). `matches` stays the finished ones. After a series finished with `autoStart`, it already shows the new series during its first match. Cheap enough for every `UpdateState`. |
| `status`               | `'idle'`, `'running'`, `'finished'` or `'stopped'`.                                           |
| `callTimeout(team)` / `endTimeout()` | Timeouts between matches. See [Timeouts](#timeouts). |
| `onSeriesStart` / `onMatchEnd` / `onSeriesEnd` | Listeners. `onSeriesStart` also fires on automatic restarts. Each returns an unsubscribe function. |
| `dispose()`            | Stops listening to the client.                                                                 |

## How teams and players are identified

- **Teams are identified by name** (`Game.Teams[].Name`), so they can switch sides between matches. Give them distinct names in the private match settings.
- **Players are identified by their `key`.** By default it comes from `playerKey()`:
  - **Real accounts:** the `PrimaryId` (e.g. `"Steam|7656119...|0"`). A player who changes their name stays one player, and `names` lists every name they used. Splitscreen players get different ids, so they stay apart.
  - **Bots:** they all share `"Unknown|0|0"`, so their key is `"bot:" + name`. Results have `bot: true` for them.
  - **Your own rule:** pass `identifyPlayer` to `EsportsSeries` or `MatchTracker`, for example to merge someone's Steam and Epic accounts:
    ```ts
    new EsportsSeries(client, { identifyPlayer: (p) => (p.PrimaryId && aliases[p.PrimaryId]) || playerKey(p) });
    ```

## What the results include

- **Per-team results** include matches played, wins and `winPercent`, goals, shots and `shootingPercent`, boost used and `boostPerMinute`, play time (`secondsPlayed`) and possession over the whole series.
- **Per-player results** (`result.players`) include the `PrimaryId`, the summed scoreboard stats, boost used, air time, wall time, average speed (weighted by `drivingTime`), crossbar hits (attack and defense), matches played, matches left early (`leftEarly`), joins and leaves summed over the matches, and the number of MVPs. Also wins and `winPercent`, `shootingPercent`, `goalParticipation` (over `teamGoals`, the goals of their team in each match they played), `secondsPlayed` and `boostPerMinute`.
- **Rates over the series** are computed from the totals, not averaged per match: `shootingPercent` is all goals over all shots, and `boostPerMinute` all boost over all play time. See [Rates and percentages](match-stats.md#rates-and-percentages).
- **`winPercent`** counts only finished matches. In `getLiveResult()`, the match being played adds to `matches` but not to `winPercent`.
- **Per-match player results:** each match in `result.matches` keeps its own `playerResults` (see [Match summary](match-stats.md#match-summary)).

## Which matches count

- Only matches that end (`MatchEnded`) while the series is running are recorded.
- **Automatic restart:** when a series finishes, its result stays in `getResult()` until the next match ends. That match then becomes the first of the new series.

## Timeouts

With the `timeouts` option, each team can call that many timeouts in the series. A timeout goes **between the end of a match and the start of the next one**. They are off by default (`timeouts: 0`).

```ts
const series = new EsportsSeries(client, { games: 5, timeouts: 1, timeoutSeconds: 300 }); // one 5-minute timeout per team

series.onTimeoutStart((timeout) => console.log(`Timeout for ${timeout.team} until ${timeout.endsAt?.toLocaleTimeString()}`));
series.onTimeoutEnd((timeout) => console.log(`Timeout of ${timeout.team} over (${timeout.endReason})`));

if (series.canCallTimeout('Blue')) series.callTimeout('Blue');
series.callTimeout(1);       // also by TeamNum: the team that played orange in the last match
series.timeoutsLeft('Blue'); // 0
series.endTimeout();         // the team is ready: ends the timeout early
```

| Method / property         | Description                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `callTimeout(team)`       | `team` is the team name, as in `teams[].name`, or its `TeamNum` in the last finished match. Returns the `SeriesTimeout`. Throws a `SeriesTimeoutError` (with a `reason`) when it can't be called. |
| `canCallTimeout(team)` / `timeoutRefusal(team)` | Whether the team can call one now, and if not, why: `'disabled'`, `'not-running'`, `'no-match-played'`, `'match-in-progress'`, `'unknown-team'`, `'no-timeouts-left'` or `'timeout-active'`. |
| `endTimeout()`            | Ends the running timeout early. Returns it, or `undefined` if none was running.         |
| `timeoutsLeft(team)` / `hasTimeoutsLeft(team)` | Timeouts the team can still call in this series, and whether it has any left (it may still not be able to call one right now: see `canCallTimeout`). |
| `teamOf(team)`            | The team name for a name or a `TeamNum`.                                                 |
| `activeTimeout`           | The running timeout, if any.                                                             |
| `onTimeoutStart` / `onTimeoutEnd` | Listeners, called with the timeout and the series result.                        |

- **By `TeamNum`:** every method that takes a team also takes a `TeamNum` (`0` blue, `1` orange). It means the side the team played on in the **last finished match**, since teams can switch sides between matches. The timeout and the results always use the team name.
- **When it can be called:** the series is running, at least one of its matches finished, no match is being played (the lobby of the next match is fine: a match starts with `MatchInitialized`), the team played in the series and has timeouts left, and no other timeout is running.
- **How it ends** (`endReason`): `'ended'` with `endTimeout()`, `'expired'` when `timeoutSeconds` run out, `'match-started'` when the next match starts with `MatchInitialized` (always, even with time left), or `'cancelled'` when the series is started again, stopped or disposed. With `timeoutSeconds: 0` there is no time limit.
- **In the results:** `result.timeouts` lists every timeout of the series (`team`, `afterMatch`, `startedAt`, `endsAt`, `endedAt`, `endReason`), `result.activeTimeout` the running one, and each team has `timeoutsUsed` and `timeoutsLeft`. A timeout that ran out before its time still counts as used.
- The timeout doesn't pause anything in the game: it's for your bot or overlay to show and enforce.
