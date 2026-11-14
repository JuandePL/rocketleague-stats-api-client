# rocketleague-stats-api-client

Fully typed WebSocket client for the official [Rocket League Stats API](https://www.rocketleague.com/developer/stats-api), with runtime type guards for every event and command.

- Typed interfaces for all 22 events and 6 commands
- Type guards that validate each message at runtime (enabled by default)
- `RocketLeagueStatsClient`: connects automatically, reconnects with backoff, and gives you typed `on()` / `onAny()` / `send()`
- No runtime dependencies. Works in Node.js >= 22 and in browsers. ESM and CommonJS builds.

## Install

```sh
npm install @juande_pl/rocketleague-stats-api-client
```

## Enable the Stats API in Rocket League

Edit `<Install Dir>\TAGame\Config\TAStatsAPI.ini` (or `DefaultStatsAPI.ini` if it doesn't exist) **before launching the game**:

```ini
[TAGame.MatchStatsExporter_TA]
PacketSendRate=30
WebPort=49124
```

| Setting          | Default | Description                                                         |
| ---------------- | ------- | ------------------------------------------------------------------- |
| `PacketSendRate` | `0`     | `UpdateState` packets per second (max 120). `0` disables the feature. |
| `Port`           | `49123` | TCP port. `0` disables it.                                          |
| `WebPort`        | `49124` | WebSocket port used by this library. `0` disables it.               |

### Automatic setup (Node.js)

On Node.js the client checks the `.ini` for you. It looks for `TAStatsAPI.ini` first, then `DefaultStatsAPI.ini`. On Windows it finds the Epic Games and Steam installs by itself. If `PacketSendRate` is `0` or less, missing, or above the maximum of `120`, it sets it to `30` and warns that **you must restart the game** for the Stats API to work. The game only reads this file at launch. In browsers the check is skipped and the Node-only code is never loaded.

```ts
import { RocketLeagueStatsClient } from '@juande_pl/rocketleague-stats-api-client';

const client = new RocketLeagueStatsClient({
  ensureStatsApi: true, // default. Or false, or { installDir, iniPath, packetSendRate, warn }
});

const config = await client.statsApiConfig;
// { status: 'updated', iniPath, previous: 0, packetSendRate: 30, restartRequired: true }
// or 'enabled' | 'not-found' | 'write-failed' (e.g. no permission under Program Files)
```

The helpers are exported from `@juande_pl/rocketleague-stats-api-client/node`. Run the check on its own with `ensureStatsApiEnabled(options)`, or use `editPacketSendRate(content)` to edit the `.ini` text without touching the disk.

## Usage

```ts
import { RocketLeagueStatsClient } from "@juande_pl/rocketleague-stats-api-client";

const client = new RocketLeagueStatsClient(); // ws://127.0.0.1:49124, connects automatically

// A single event: `data` is typed as GoalScoredData
client.on('GoalScored', (data) => {
  console.log(`${data.Scorer.Name} scored at ${data.GoalSpeed} uu/s`);
});

// Every event, as a discriminated union
client.onAny((event) => {
  if (event.Event === 'StatfeedEvent') {
    console.log(event.Data.MainTarget.Name, event.Data.EventName);
  }
});

// Commands: checked at compile time and validated at runtime
client.send('ChangePOV', { Focus: '1', Perspective: 'PlayerView' });
client.send({ Command: 'SetHUDVisibility', Data: { bVisible: false } });
```

### Options

```ts
new RocketLeagueStatsClient({
  host: '127.0.0.1',     // default
  port: 49124,           // default (WebPort)
  secure: false,         // use wss://
  url: undefined,        // full URL, overrides host/port/secure
  autoConnect: true,     // set to false and call client.connect() yourself
  reconnect: true,       // or false, or { initialDelay, maxDelay, factor, maxAttempts }
  validateEvents: true,  // run type guards on incoming events
  ignoreReplayEndGoal: true, // drop the fake GoalScored sent when a replay ends
  sortPlayers: undefined, // sort UpdateState.Players (see below). Default: the game's order
  WebSocket: undefined,  // custom implementation, defaults to globalThis.WebSocket
  ensureStatsApi: true,  // Node.js only: enable PacketSendRate in the .ini (see above)
});
```

With `autoConnect: true`, the connection opens on the next microtask, so listeners you add right after `new` still get the `connect` event. If the game isn't running yet, the client keeps retrying with exponential backoff (1 s, 2 s, 4 s … up to 30 s).

On Node.js < 22, pass the `ws` package: `new RocketLeagueStatsClient({ WebSocket: (await import('ws')).default })`.

### Listening

| Method                          | Description                                                                 |
| ------------------------------- | --------------------------------------------------------------------------- |
| `on(name, listener)`            | Game event (`'GoalScored'`, …) or lifecycle event. Returns an unsubscribe function. |
| `once(name, listener)`          | Same as `on`, but the listener runs only once.                              |
| `off(name, listener)`           | Removes a listener.                                                         |
| `onAny(listener)` / `offAny()`  | Every game event, as `StatsApiEvent` (narrow with `event.Event`).           |
| `waitFor(name, { timeout })`    | Promise that resolves with the next payload of that event.                  |
| `removeAllListeners(name?)`     | Removes every listener, or every listener for one name.                     |

Game event listeners receive `(data, event)`: the typed payload and the full `{ Event, Data }` message.

Lifecycle events:

| Name             | Arguments                                   |
| ---------------- | ------------------------------------------- |
| `connect`        | none                                        |
| `disconnect`     | `{ code, reason, willReconnect }`           |
| `reconnecting`   | `{ attempt, delay }`                        |
| `error`          | `Error` (`ConnectionError`, `ListenerError`) |
| `invalidMessage` | `ParseFailure` (`reason`, `raw`, `event?`, `data?`) |

Errors are only reported to `error` listeners. A throwing listener doesn't stop the other listeners from running.

### Sending commands

`send(command, data)` or `send({ Command, Data })`. It throws:

- `CommandValidationError` if the command name or payload is invalid (for example, `ChangePOV` with neither `Focus` nor `Perspective`, or `SetGameSpeed` with a negative speed).
- `NotConnectedError` if the socket is not open.

| Command            | Payload                                                         |
| ------------------ | --------------------------------------------------------------- |
| `ChangePOV`        | `{ Focus?: 'Ball' \| '<shortcut>', Perspective?: Perspective }` (at least one) |
| `LoadReplay`       | `{ FileName?: string, Path?: string }` (at least one)            |
| `SeekReplay`       | `{ Frame?: number, TimeSeconds?: number }` (at least one)        |
| `SetGameSpeed`     | `{ Speed: number }` (≥ 0)                                       |
| `SetHUDVisibility` | `{ bVisible: boolean }`                                         |
| `SetMatchPaused`   | `{ bPaused: boolean }`                                          |

`Perspective` is one of `'Fly' | 'SoftAttach' | 'HardAttach' | 'PlayerView' | 'AutoCam' | 'Camera_Director'`.

## Sorting players

By default `UpdateState.Players` arrives in the order the game sends it. To change that, pass `sortPlayers` to the client, or call `sortPlayers()` yourself on any player list:

```ts
import { RocketLeagueStatsClient, sortPlayers, byTeam, byStat, byName, byShortcut } from '@juande_pl/rocketleague-stats-api-client';

// Every UpdateState: Blue then Orange, best score first within each team
const client = new RocketLeagueStatsClient({ sortPlayers: [byTeam(), byStat('Score')] });

// Or on demand. Returns a new array and doesn't change the original.
const byBoost = sortPlayers(data.Players, byStat('Boost'));
const custom = sortPlayers(data.Players, (a, b) => a.Demos - b.Demos);
```

| Comparator                    | Order                                                              |
| ----------------------------- | ------------------------------------------------------------------ |
| `byTeam(order = 'asc')`       | Blue (0) first. `'desc'` puts Orange first.                        |
| `byShortcut(order = 'asc')`   | Spectator shortcut.                                                |
| `byName(order = 'asc')`       | Name, case-insensitive.                                            |
| `byStat(stat, order = 'desc')`| Any numeric field (`Score`, `Goals`, `Boost`…). Missing values go last. |

The first comparator decides and the next ones break ties. The sort is stable, so players that compare equal keep the game's order.

## Match stats and esports mode

### Quick helpers

These work on any player list, such as `UpdateState.Players`:

```ts
import { getMvp, getTopPlayer, getTeamTotals } from '@juande_pl/rocketleague-stats-api-client';

getMvp(data.Players, winnerTeamNum);  // highest score on the winning team (ties: goals, assists, saves, shots)
getTopPlayer(data.Players, 'Saves');  // player with the most saves
getTeamTotals(data.Players);          // { blue: { Score, Goals, Shots, ... }, orange: { ... } }
```

### `MatchTracker`: possession, boost and field domination

```ts
import { MatchTracker } from '@juande_pl/rocketleague-stats-api-client';

const tracker = new MatchTracker(client);
const stats = tracker.getStats(); // any time during the match
tracker.onMatchEnd((summary) => console.log(summary.mvp?.Name, summary.possession.percent));
```

| Stat                | How it is computed                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| `possession`        | Time each team was the last to touch the ball (`Game.Ball.TeamNum`). In seconds and in percent.        |
| `boost`             | Each tick, how much each player's boost went down, summed per player and per team. Pickups and demolitions don't count. |
| `fieldDomination`   | Time the ball spent in each half. `pressure` credits the attacking team: ball 80% in the blue half = 80% pressure for orange. |
| `players[].airTime` | Seconds each player spent in the air: neither on the ground nor on a wall, and not demolished.          |
| `players[].onWallTime` | Seconds each player spent driving on a wall (`bOnWall`), not demolished.                            |
| `players[].crossbar` | Crossbar and post hits (`CrossbarHit`) by each player: `attack` on the opponent's goal, `defense` on their own goal. |

Only time with the ball in play counts. Kickoff countdowns and goal replays are excluded, and overtime is counted. **While the match is paused (`MatchPaused` until `MatchUnpaused`), everything is frozen:** time, possession, field domination, boost usage, air time, wall time and crossbar hits. Check `tracker.paused` to know if it is paused. The tracker resets on its own when a new match starts.

When the match ends, it gives you a `MatchSummary` with the teams, the winner and the MVP. Its `playerResults` has one entry per player: the scoreboard (`Score`, `Goals`, `Assists`, `Saves`, `Shots`, …), `team`, `mvp`, `boostUsed`, `airTime`, `onWallTime` and `crossbar`. The raw scoreboard sent by the game is in `scoreboard`.

> **Limitations:**
> - `UpdateState` has no ball position, so field domination uses the location of the last `BallHit` until the next touch. If the ball crosses midfield without being touched, it is still counted in the half where it was last hit.
> - `Boost`, `bOnGround` and `bOnWall` are `SPECTATOR` fields, so boost usage, air time and wall time are only tracked while spectating.
> - The game sets `bOnGround` only with 3 or more wheels down, so driving on 2 wheels counts as air time.

### `EsportsSeries`: esports mode

Records series of matches in memory and gives you the results. By default it records on its own: the series starts right away, and a new one starts after each series ends.

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
series.tracker.getStats();                        // live stats of the current match
```

| Method / property      | Description                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `new EsportsSeries(client, { games, format, autoStart })` | `games` defaults to `5`, `format` to `'best-of'`, `autoStart` to `true`. |
| `start({ games, format })` | Starts a series. Clears any stored matches. `format`: `'best-of'` (default) or `'play-all'`. |
| `restart()`            | Starts again with the same options. Clears the stored matches.                                |
| `stop()`               | Stops recording, and the automatic restart until the next `start()` or `restart()`. The matches played so far stay in `getResult()`. |
| `getResult()`          | `{ status, finished, matches, teams, winner, players, mvp }`                                  |
| `status`               | `'idle'`, `'running'`, `'finished'` or `'stopped'`.                                           |
| `onSeriesStart` / `onMatchEnd` / `onSeriesEnd` | Listeners. `onSeriesStart` also fires on automatic restarts. Each returns an unsubscribe function. |
| `dispose()`            | Stops listening to the client.                                                                 |

- **Teams are identified by name** (`Game.Teams[].Name`), so they can switch sides between matches. Give them distinct names in the private match settings.
- **Per-team results** include wins, goals, boost used, possession and pressure over the whole series.
- **Per-player results** (`result.players`) include the summed scoreboard stats, boost used, air time, wall time, crossbar hits (attack and defense), matches played and the number of MVPs.
- **Per-match player results:** each match in `result.matches` keeps its own `playerResults`.
- **Which matches count:** only matches that end (`MatchEnded`) while the series is running are recorded.
- **Automatic restart:** when a series finishes, its result stays in `getResult()` until the next match ends. That match then becomes the first of the new series.

## Type guards

Every guard is exported, so you can validate messages from any source (the TCP port, recordings, a relay server…):

```ts
import { isStatsApiEvent, isGoalScoredData, isEventData, isStatsApiCommand, parseEventMessage } from '@juande_pl/rocketleague-stats-api-client';

isGoalScoredData(payload);                 // payload is GoalScoredData
isEventData('BallHit', payload);           // payload is BallHitData
isStatsApiEvent(message);                  // message is StatsApiEvent
isStatsApiEvent(message, 'MatchEnded');    // message is StatsApiEventOf<'MatchEnded'>
isStatsApiCommand(command, 'ChangePOV');   // command is StatsApiCommandOf<'ChangePOV'>

// Decodes the wire format ({ Event, Data: "<json string>" }). Never throws.
const result = parseEventMessage(rawText);
if (result.ok) console.log(result.event.Event);
else console.warn(result.reason); // 'invalid-json' | 'invalid-envelope' | 'invalid-data-json' | 'unknown-event' | 'invalid-data'
```

Guards accept extra, undocumented fields, so new fields added by a game update don't break validation. Fields the docs mark `SPECTATOR` or `CONDITIONAL` (and `MatchGuid`, which is only set online or on LAN) are optional.

The building blocks (`shape`, `optional`, `arrayOf`, `oneOf`, `isString`, `isNumber`, …) are exported too.

## Known quirks

- `StatfeedEvent.Type` is a localized label. Use `EventName` in your logic.
- `GoalScored.GoalTime` is the length of the previous round, not the match clock.
- In offline exhibitions or with splitscreen players, `StatfeedEvent` can arrive more than once.
- When a replay ends, the game sends a fake `GoalScored` event whose `Scorer` is `{ "Name": "", "Shortcut": 0, "TeamNum": 0 }`. The client drops it by default. Pass `ignoreReplayEndGoal: false` to receive it, and use `isReplayEndGoal(event)` to detect it yourself.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

## License

MIT. This project is not affiliated with Psyonix or Epic Games.
