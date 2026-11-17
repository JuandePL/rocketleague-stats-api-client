# Match stats

[← Docs index](README.md) · [README](../README.md)

## Contents

- [Quick helpers](#quick-helpers)
- [Speed units](#speed-units)
- [`MatchTracker`](#matchtracker)
  - [Tracked stats](#tracked-stats)
  - [What time counts](#what-time-counts)
  - [Match summary](#match-summary)
  - [Live player results](#live-player-results)
  - [Players who leave early](#players-who-leave-early)
  - [Joins, leaves and team changes](#joins-leaves-and-team-changes)
  - [Formatting the clock](#formatting-the-clock)
- [Time between a player leaving and another moment](#time-between-a-player-leaving-and-another-moment)
- [Limitations](#limitations)

## Quick helpers

These work on any player list, such as `UpdateState.Players`:

```ts
import { getMvp, getTopPlayer, getTeamTotals } from '@juande_pl/rocketleague-stats-api-client';

getMvp(data.Players, winnerTeamNum);  // highest score on the winning team (ties: goals, assists, saves, shots)
getTopPlayer(data.Players, 'Saves');  // player with the most saves
getTeamTotals(data.Players);          // { blue: { Score, Goals, Shots, ... }, orange: { ... } }
```

## Speed units

Every speed from the game (`Speed`, `GoalSpeed`, `BallSpeed`, `Game.Ball.Speed`, `averageSpeed`, …) is in km/h. For mph:

```ts
import { convertSpeed, toMph } from '@juande_pl/rocketleague-stats-api-client';

toMph(data.GoalSpeed);             // km/h → mph
convertSpeed(data.GoalSpeed, unit); // unit: 'kmh' (as is) or 'mph', handy when it is a setting
```

## `MatchTracker`

Tracks possession, boost, air time, speed and crossbar hits.

```ts
import { MatchTracker } from '@juande_pl/rocketleague-stats-api-client';

const tracker = new MatchTracker(client);
const stats = tracker.getStats(); // any time during the match
const live = tracker.getPlayerResults(); // live scoreboard + tracked stats per player
tracker.onMatchEnd((summary) => console.log(summary.mvp?.Name, summary.possession.percent));
```

### Tracked stats

| Stat                | How it is computed                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| `possession`        | Time each team was the last to touch the ball (`Game.Ball.TeamNum`). In seconds and in percent.        |
| `boost`             | Each tick, how much each player's boost went down, summed per player and per team. Pickups and demolitions don't count. |
| `players[].airTime` | Seconds each player spent in the air: neither on the ground nor on a wall, and not demolished.          |
| `players[].onWallTime` | Seconds each player spent driving on a wall (`bOnWall`), not demolished.                            |
| `players[].averageSpeed` | Average car speed (`Speed`) in km/h, not demolished. `toMph()` converts it. `drivingTime` is the time it covers. |
| `players[].crossbar` | Crossbar and post hits (`CrossbarHit`) by each player: `attack` on the opponent's goal, `defense` on their own goal. One per touch: the extra `CrossbarHit` the game sends for the same impact are ignored. |

### What time counts

Only time with the ball in play counts. Kickoff countdowns and goal replays are excluded, and overtime is counted. **While the match is paused (`MatchPaused` until `MatchUnpaused`), everything is frozen:** time, possession, boost usage, air time, wall time, speed and crossbar hits. Check `tracker.paused` to know if it is paused. The tracker resets on its own when a new match starts.

### Match summary

When the match ends, it gives you a `MatchSummary` with the teams, the winner and the MVP. Its `playerResults` has one entry per player: `PrimaryId`, the scoreboard (`Score`, `Goals`, `Assists`, `Saves`, `Shots`, …), `team`, `mvp`, `leftEarly`, `boostUsed`, `airTime`, `onWallTime`, `averageSpeed`, `drivingTime` and `crossbar`. The raw scoreboard sent by the game is in `scoreboard`.

### Live player results

`tracker.getPlayerResults()` gives the same entries as `playerResults` at any time, so you can show them on every `UpdateState`. While the match is running, `mvp` marks the provisional MVP (best player of the leading team, or of everyone on a tie) and `leftEarly` marks players who are not in the match right now. `tracker.matchInProgress` tells if a match is being tracked.

### Players who leave early

Players who leave before the end (rage quit, disconnect) stay in `playerResults` with `leftEarly: true` and the stats they had when they were last seen. They can't be MVP. A player who leaves and comes back before the end counts as a normal player.

`leftAt` tells when they left:

- `clock`: the match clock as text, like `"02:35"`, or `"+01:10"` in overtime.
- `timeSeconds` and `overtime`: the same clock as raw values.
- `secondsPlayed`: seconds of play until then.
- `date`: the real time.

### Joins, leaves and team changes

Every player result has `sessions`, one entry per stretch of time the player was in the match:

```ts
sessions: [
  { team: 'Blue', TeamNum: 0, joinedAt: MatchMoment, leftAt: MatchMoment, switchedTeam: false }, // left
  { team: 'Blue', TeamNum: 0, joinedAt: MatchMoment, switchedTeam: false },                      // came back, still in at the end
],
joins: 2,  // times the player entered, the first time included
leaves: 1, // times the player left before the end
```

- A team change ends the session (`switchedTeam: true`) and starts a new one on the new team. It counts as neither a join nor a leave.
- `leftAt` is the last `UpdateState` the player was in, so the real exit is at most one tick later. An open session (no `leftAt`) means the player was in at the end, or is in right now for `getPlayerResults()`.
- They come from `UpdateState`, so they work for bots too, and they include the team. `PlayerJoined` / `PlayerLeft` are in the `timeline` too, without the team.

### Formatting the clock

`formatMatchClock(timeSeconds, overtime)` formats any clock value the same way. Minutes have two digits by default. Pass `{ padMinutes: false }` for `"2:35"`.

## Time between a player leaving and another moment

Measure the time from a player leaving to the end of the match, the next goal, or any event:

```ts
import { timeFromPlayerLeftToMatchEnd, timeFromPlayerLeftToNextGoal, timeFromPlayerLeftTo, timeBetween } from '@juande_pl/rocketleague-stats-api-client';

timeFromPlayerLeftToMatchEnd(summary, player);        // { secondsPlayed, clockSeconds, realSeconds } until the match ended
timeFromPlayerLeftToNextGoal(summary, player);   // until the next goal, by any team
timeFromPlayerLeftTo(summary, player, 'GoalScored', (e) => e.Data.Scorer.TeamNum !== player.TeamNum); // until their team conceded
timeFromPlayerLeftTo(summary, player, 'StatfeedEvent', (e) => e.Data.EventName === 'Save');              // any event, with an optional filter
timeBetween(summary.goals[0].moment, summary.endMoment);                                           // any two moments
```

- **Return value:** `undefined` if the player didn't leave early, or if no such event happened after they left.
- **`player`:** a `MatchPlayerResult` or its `key`.
- **The three measures:**
  - `secondsPlayed`: play time only. Countdowns, replays and pauses are left out.
  - `clockSeconds`: time on the match clock. Regulation time and overtime add up.
  - `realSeconds`: real time.
- **Where the moments come from:** every `MatchSummary` has `endMoment`, `goals` (each with its `moment`) and `timeline`. The timeline holds every event of the match except `UpdateState`, each with the moment it arrived. Live, use `tracker.getTimeline()` and `tracker.getMoment()`.

## Limitations

- There is no field domination (time the ball spends in each half): `UpdateState` doesn't send the ball position. It will be added if a future Stats API update includes it.
- `Boost`, `Speed`, `bOnGround` and `bOnWall` are `SPECTATOR` fields, so boost usage, speed, air time and wall time are only tracked while spectating.
- The game sets `bOnGround` only with 3 or more wheels down, so driving on 2 wheels counts as air time.
- On the ceiling, the game sends `bOnGround: true` and `bOnWall: false`, so ceiling time counts as ground: neither air time nor wall time.
