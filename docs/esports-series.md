# Esports mode: `EsportsSeries`

[← Docs index](README.md) · [README](../README.md)

Records series of matches in memory and gives you the results. By default it records on its own: the series starts right away, and a new one starts after each series ends. Each match is tracked with a [`MatchTracker`](match-stats.md#matchtracker), available as `series.tracker`.

## Contents

- [Usage](#usage)
- [API](#api)
- [How teams and players are identified](#how-teams-and-players-are-identified)
- [What the results include](#what-the-results-include)
- [Which matches count](#which-matches-count)

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
| `new EsportsSeries(client, { games, format, autoStart })` | `games` defaults to `5`, `format` to `'best-of'`, `autoStart` to `true`. |
| `start({ games, format })` | Starts a series. Clears any stored matches. `format`: `'best-of'` (default) or `'play-all'`. |
| `restart()`            | Starts again with the same options. Clears the stored matches.                                |
| `stop()`               | Stops recording, and the automatic restart until the next `start()` or `restart()`. The matches played so far stay in `getResult()`. |
| `getResult()`          | `{ status, finished, matches, teams, winner, players, mvp }`, with the finished matches.      |
| `getLiveResult()`      | Like `getResult()`, but team and player totals also include the match being played (no win until it ends). `matches` stays the finished ones. After a series finished with `autoStart`, it already shows the new series during its first match. Cheap enough for every `UpdateState`. |
| `status`               | `'idle'`, `'running'`, `'finished'` or `'stopped'`.                                           |
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

- **Per-team results** include wins, goals, boost used and possession over the whole series.
- **Per-player results** (`result.players`) include the `PrimaryId`, the summed scoreboard stats, boost used, air time, wall time, average speed (weighted by `drivingTime`), crossbar hits (attack and defense), matches played, matches left early (`leftEarly`), joins and leaves summed over the matches, and the number of MVPs.
- **Per-match player results:** each match in `result.matches` keeps its own `playerResults` (see [Match summary](match-stats.md#match-summary)).

## Which matches count

- Only matches that end (`MatchEnded`) while the series is running are recorded.
- **Automatic restart:** when a series finishes, its result stays in `getResult()` until the next match ends. That match then becomes the first of the new series.
