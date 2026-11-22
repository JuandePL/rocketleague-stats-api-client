# Esports mode: `EsportsSeries`

[← Docs index](README.md) · [README](../README.md)

Records series of matches in memory and gives you the results. By default it records on its own: the series starts right away, and after each series ends a new one starts with the next match. Each match is tracked with a [`MatchTracker`](match-stats.md#matchtracker), available as `series.tracker`.

## Contents

- [Usage](#usage)
- [API](#api)
- [How teams and players are identified](#how-teams-and-players-are-identified)
- [What the results include](#what-the-results-include)
- [Which matches count](#which-matches-count)
- [Timeouts](#timeouts)
- [Changing the options](#changing-the-options)
- [Pausing a series](#pausing-a-series)
- [Fixing the score by hand](#fixing-the-score-by-hand)
- [Renaming teams](#renaming-teams)
- [Saving and restoring a series](#saving-and-restoring-a-series)
- [Reconnecting with a new client](#reconnecting-with-a-new-client)

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
| `getResult()`          | `{ status, finished, matches, abortedMatches, teams, winner, players, mvp, timeouts, activeTimeout }`, with the finished matches.      |
| `getLiveResult()`      | Like `getResult()`, but team and player totals also include the match being played (no win until it ends). `matches` stays the finished ones. With `autoStart`, if the series finished during the match (changed by hand or restored), it already shows the next series. Cheap enough for every `UpdateState`. |
| `status`               | `'idle'`, `'running'`, `'paused'`, `'finished'` or `'stopped'`.                               |
| `options` / `setOptions(options)` / `setGames()` / `setTimeouts()` / `setTimeoutSeconds()` | Read or change the options without starting again. See [Changing the options](#changing-the-options). |
| `pause()` / `resume()` / `paused` | Stop recording for a while. See [Pausing a series](#pausing-a-series). |
| `callTimeout(team)` / `endTimeout()` | Timeouts between matches. See [Timeouts](#timeouts). |
| `abortedMatches` / `onMatchAbort` | Matches left before their end. See [Which matches count](#which-matches-count). |
| `onSeriesStart` / `onMatchEnd` / `onSeriesEnd` | Listeners. `onSeriesStart` also fires on automatic restarts. Each returns an unsubscribe function. |
| `adjustWins(team, delta)` / `setWins(team, wins)` / `winsOf(team)` / `removeLastMatch()` | Fix the score by hand. See [Fixing the score by hand](#fixing-the-score-by-hand). |
| `teamResult(team, result?)` | A team's results by name or `TeamNum`, also before it played (zeros, and every timeout left to show). Pass `getLiveResult()` as `result` for live ones. |
| `renameTeams(renames)` | Renames teams in everything recorded. See [Renaming teams](#renaming-teams). |
| `snapshot({ timeline })` / `restore(snapshot)` | Save and bring back the series. See [Saving and restoring a series](#saving-and-restoring-a-series). |
| `onUpdate`             | Called after anything stored changes (start, stop, matches, manual wins, timeouts, restore). Not on every `UpdateState`. |
| `dispose()`            | Stops listening to the client.                                                                 |

## How teams and players are identified

- **Teams are identified by name** (`Game.Teams[].Name`), so they can switch sides between matches. Give them distinct names in the private match settings.
- **Your own team names:** pass `identifyTeam` to name the teams yourself, for example with the teams of your broadcast when the names in the game are the default ones. It gets `{ TeamNum, Name }` and returns the name to use (an empty string keeps the default). Each finished match keeps the names it was played with, so switching sides later doesn't change the past matches:
  ```ts
  const sides = { 0: 'Karmine Corp', 1: 'Team Vitality' }; // updated by your control panel
  new EsportsSeries(client, { identifyTeam: (team) => sides[team.TeamNum] ?? team.Name });
  ```
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
- **Team totals of players:** `score` (player points, not goals), `assists`, `saves`, `demos`, `touches`, `carTouches` and `airTime`, summed match by match. Don't sum `result.players` by their `team` for this: that is only the team of their last match.
- **`matchesDecided`** is the matches with a winner, with the wins by hand. **`currentMatch`** is the number to show: the match being played, the one just over while `tracker.phase` is `'ended'`, else the next one (the last one once the series is over). It changes with `tracker.phase`, which doesn't call `onUpdate`.
- **`winPercent`** counts only finished matches. In `getLiveResult()`, the match being played adds to `matches` but not to `winPercent`.
- **Per-match player results:** each match in `result.matches` keeps its own `playerResults` (see [Match summary](match-stats.md#match-summary)).

## Which matches count

- Only matches that end (`MatchEnded`) while the series is running are recorded.
- **Matches left before their end:** if the lobby is destroyed (`MatchDestroyed`) before `MatchEnded`, for example because everyone left, the match is kept apart in `abortedMatches` with the stats until then, and `onMatchAbort` is called. It doesn't count for anything else: not for wins, team and player totals, nor the end of the series. So the match can be played again. A match left before anything was played (in the lobby, or during the first kickoff countdown after `MatchInitialized`) is just dropped.
- **Automatic restart:** when a series finishes, its result stays in `getResult()` until the next match **starts** (`MatchInitialized`, not the lobby after `MatchCreated`). The new series starts then, at 0-0, with that match as its first: `onSeriesStart` and `onUpdate` are called, and `tracker.onMatchStart` listeners already see the new series.
  - When joining a match midway, it starts with the first `UpdateState`. Joining on the end screen of a match (`bHasWinner`) or in a lobby (5:00 and 0-0) starts nothing, so a restored result stays. Neither does a replay opened from the match history (`ReplayCreated`).
  - If the start of a match was missed, it is recognized by another `MatchGuid` or by the clock going back up without more goals (matches played one after another in a lobby have the same `MatchGuid`).
  - If the start of the match wasn't seen, or the series finished during the match (wins or options changed by hand), the new series starts when that match ends.
  - To reopen a finished series (a Bo3 that was really a Bo5, a wrong win), use `setOptions()`, `adjustWins()` or `removeLastMatch()` **before the next match starts**. To keep a result longer, save it in `onSeriesEnd`, call `stop()`, or use `autoStart: false`.

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

## Changing the options

`start()` clears the series. To change the format or the timeouts of the series being played, keeping its matches:

```ts
series.setOptions({ games: 7 });            // best of 5 → best of 7: the series goes on
series.setGames(3, 'play-all');             // also the format
series.setTimeouts(1, 300);                 // one 5-minute timeout per team
series.setTimeoutSeconds(0);                // no time limit
series.options;                             // { games: 3, format: 'play-all', timeouts: 1, timeoutSeconds: 0 }
```

- Only the fields given change. Invalid values throw a `RangeError` like in the constructor, and nothing changes.
- The series ends (`onSeriesEnd`) or goes on again with the new options.
- A team that used more timeouts than the new limit has `0` left. A running timeout gets the new length from when it started, and ends right away (`'expired'`) if that time already passed.
- `onUpdate` is called.

## Pausing a series

```ts
series.pause();   // status 'paused': matches that end now are not recorded
series.resume();  // records again
```

- For a showmatch, a test or a rematch between two matches of the series. Matches that end or are left while paused are ignored, and no timeout can be called (`'not-running'`).
- The results, the manual wins and a running timeout stay. `adjustWins()` and `setOptions()` still work, and the series can end when it resumes.
- `pause()` only works while `running`, `resume()` only while `paused`. Both return `true` when they did something. `stop()` also stops a paused series.

## Fixing the score by hand

For a match played outside the game's view, a forfeit, or a wrong result:

```ts
series.adjustWins('Karmine Corp', 1);  // one more win (also by TeamNum, see teamOf)
series.adjustWins(1, -1);              // one less for the team that played orange in the last match
series.setWins('Team Vitality', 2);    // exactly 2 wins
series.winsOf('Team Vitality');        // 2, manual wins included
series.removeLastMatch();              // the last recorded match doesn't count anymore
```

- Wins by hand are counted net: `-1` for a team and `+1` for the other corrects a result without adding a match.
- Wins never go below `0`. Only while the series is `running` or `finished`. `start()` and `restart()` clear them.
- The series ends (`onSeriesEnd`) or goes on again with the new score. In `play-all`, each manual win also counts as a match played.
- Results show them in `manualWins` (per team, already counted in `wins`, and for the whole series). `winPercent` only looks at the matches played.

## Renaming teams

Teams are identified by name, so renaming one is renaming it in everything recorded:

```ts
series.renameTeams({ 'Team 1': 'Karmine Corp' });
series.renameTeams({ A: 'B', B: 'A' });                // all at once: they exchange names
const copy = renameSnapshotTeams(series.snapshot(), { A: 'Alpha' }); // only a copy, to show other names
```

Wins, results, players and timeouts go with the names, and two teams renamed to the same name become one. The match being played gets its names from `identifyTeam`.

## Saving and restoring a series

`snapshot()` returns everything the series stores: options, status, matches, aborted matches, timeouts and manual wins. It can go through `JSON.stringify`, and `restore()` turns the dates back into dates:

```ts
series.onUpdate(() => fs.writeFileSync('series.json', JSON.stringify(series.snapshot())));

const restored = new EsportsSeries(client, { autoStart: false });
restored.restore(JSON.parse(fs.readFileSync('series.json', 'utf8')));
```

- `snapshot({ timeline: false })` leaves out the timeline of each match (every event of it): much smaller, to save or send it often. The results don't need it.
- `restore()` replaces everything stored and calls `onUpdate`, not `onSeriesStart`.
- A running timeout goes on until its `endsAt`, or ends right away (`'expired'`) if that time already passed.
- The match being played is not in the snapshot: after a restart the tracker picks it up from the next `UpdateState` and records it when it ends, with the stats from then on.

## Reconnecting with a new client

To change the client (another host or port) without losing the series, give it an `EventRelay`:

```ts
const relay = new EventRelay();
const series = new EsportsSeries(relay);
let stop = relay.forward(client);

// Later, with another client:
stop();
stop = relay.forward(otherClient);
```

## A copy of a series kept elsewhere

When another app owns the series and sends you its snapshots, use `mirror`. It follows the match being played for the live results, but only `restore()` changes what is recorded:

```ts
const copy = new EsportsSeries(client, { mirror: true });
onSnapshotReceived((snapshot) => copy.restore(snapshot));
```
