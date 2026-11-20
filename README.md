# rocketleague-stats-api-client

Fully typed WebSocket client for the official [Rocket League Stats API](https://www.rocketleague.com/developer/stats-api), with runtime type guards for every event and command.

- Typed interfaces for all 22 events and 6 commands
- Type guards that validate each message at runtime (enabled by default)
- `RocketLeagueStatsClient`: connects automatically, reconnects with backoff, and gives you typed `on()` / `onAny()` / `send()`
- Match stats (possession, boost, air time, speed…) and an esports mode that records whole series
- No runtime dependencies. Works in Node.js >= 22 and in browsers. ESM and CommonJS builds.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Enable the Stats API in Rocket League](#enable-the-stats-api-in-rocket-league)
  - [Automatic setup (Node.js)](#automatic-setup-nodejs)
- [Client](#client)
  - [Options](#options)
  - [Listening to events](#listening-to-events)
  - [Lifecycle events](#lifecycle-events)
  - [Sending commands](#sending-commands)
- [Sorting players](#sorting-players)
- [Match stats](#match-stats)
- [Esports mode](#esports-mode)
- [Type guards](#type-guards)
- [Known quirks](#known-quirks)
- [Documentation](#documentation)
- [Development](#development)
- [License](#license)

## Install

```sh
npm install @juande_pl/rocketleague-stats-api-client
```

## Quick start

```ts
import { RocketLeagueStatsClient } from "@juande_pl/rocketleague-stats-api-client";

const client = new RocketLeagueStatsClient(); // ws://127.0.0.1:49124, connects automatically

// A single event: `data` is typed as GoalScoredData
client.on('GoalScored', (data) => {
  console.log(`${data.Scorer.Name} scored at ${data.GoalSpeed} km/h`);
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

More in [examples/](examples/).

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

## Client

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
  sortPlayers: undefined, // sort UpdateState.Players (see Sorting players). Default: the game's order
  WebSocket: undefined,  // custom implementation, defaults to globalThis.WebSocket
  ensureStatsApi: true,  // Node.js only: enable PacketSendRate in the .ini (see Automatic setup)
});
```

With `autoConnect: true`, the connection opens on the next microtask, so listeners you add right after `new` still get the `connect` event. If the game isn't running yet, the client keeps retrying with exponential backoff (1 s, 2 s, 4 s … up to 30 s).

On Node.js < 22, pass the `ws` package: `new RocketLeagueStatsClient({ WebSocket: (await import('ws')).default })`.

### Listening to events

| Method                          | Description                                                                 |
| ------------------------------- | --------------------------------------------------------------------------- |
| `on(name, listener)`            | Game event (`'GoalScored'`, …) or lifecycle event. Returns an unsubscribe function. |
| `once(name, listener)`          | Same as `on`, but the listener runs only once.                              |
| `off(name, listener)`           | Removes a listener.                                                         |
| `onAny(listener)` / `offAny()`  | Every game event, as `StatsApiEvent` (narrow with `event.Event`).           |
| `waitFor(name, { timeout })`    | Promise that resolves with the next payload of that event.                  |
| `removeAllListeners(name?)`     | Removes every listener, or every listener for one name.                     |

Game event listeners receive `(data, event)`: the typed payload and the full `{ Event, Data }` message.

### Lifecycle events

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

## Match stats

Quick helpers for any player list, and a `MatchTracker` that follows the whole match:

```ts
import { getMvp, getTopPlayer, getTeamTotals, toMph, MatchTracker } from '@juande_pl/rocketleague-stats-api-client';

getMvp(data.Players, winnerTeamNum);  // highest score on the winning team
getTopPlayer(data.Players, 'Saves');  // player with the most saves
getTeamTotals(data.Players);          // { blue: { Score, Goals, Shots, ... }, orange: { ... } }
toMph(data.GoalSpeed);                // every speed from the game is in km/h

const tracker = new MatchTracker(client);
tracker.getStats();         // possession, boost used, air time, wall time, average speed, crossbar hits
tracker.getPlayerResults(); // live scoreboard + tracked stats per player
tracker.onMatchEnd((summary) => console.log(summary.mvp?.Name, summary.possession.percent));
```

The tracker only counts time with the ball in play, freezes while the match is paused, keeps players who leave early (with when they left), and records every join, leave and team change. Player and team results also have shooting %, goal participation, boost per minute and the win, and series results add the win %.

**Full reference: [docs/match-stats.md](docs/match-stats.md)**, including how each stat is computed, the `MatchSummary`, time between moments (`timeFromPlayerLeftToMatchEnd`…) and the limitations.

## Esports mode

`EsportsSeries` records best-of or play-all series in memory and gives you team and player totals, the winner and the series MVP:

```ts
import { EsportsSeries } from '@juande_pl/rocketleague-stats-api-client';

const series = new EsportsSeries(client, { games: 5 }); // best of 5, recording right away
series.onSeriesEnd((result) => console.log(`${result.winner} wins the series. MVP: ${result.mvp?.Name}`));
series.getLiveResult(); // standings, also counting the match being played
```

Fix the score by hand with `adjustWins()` / `removeLastMatch()`, give teams your own names with `identifyTeam`, and save a series across restarts with `snapshot()` / `restore()`.

**Full reference: [docs/esports-series.md](docs/esports-series.md)**, including every method, how teams and players are identified, which matches count, manual wins and snapshots.

## Type guards

Every guard is exported, so you can validate messages from any source (the TCP port, recordings, a relay server…):

```ts
import { isStatsApiEvent, isGoalScoredData, parseEventMessage } from '@juande_pl/rocketleague-stats-api-client';

isGoalScoredData(payload);              // payload is GoalScoredData
isStatsApiEvent(message, 'MatchEnded'); // message is StatsApiEventOf<'MatchEnded'>

const result = parseEventMessage(rawText); // decodes the wire format. Never throws.
if (result.ok) console.log(result.event.Event);
```

**Full reference: [docs/type-guards.md](docs/type-guards.md).**

## Known quirks

- `StatfeedEvent.Type` is a localized label. Use `EventName` in your logic.
- `GoalScored.GoalTime` is the length of the previous round, not the match clock.
- In offline exhibitions or with splitscreen players, `StatfeedEvent` can arrive more than once.
- Every speed (`Player.Speed`, `Game.Ball.Speed`, `GoalSpeed`, `BallSpeed`, `BallLastTouch.Speed`, …) is in km/h, not in Unreal Units/second.
- A car on the ceiling is reported as `bOnGround: true`, `bOnWall: false`, the same as on the ground.
- When a replay ends, the game sends a fake `GoalScored` event whose `Scorer` is `{ "Name": "", "Shortcut": 0, "TeamNum": 0 }`. The client drops it by default. Pass `ignoreReplayEndGoal: false` to receive it, and use `isReplayEndGoal(event)` to detect it yourself.

## Documentation

| Page | What it covers |
| ---- | -------------- |
| [Match stats](docs/match-stats.md) | Quick helpers, speed units, `MatchTracker`, players who leave early, joins and team changes, time between moments, limitations. |
| [Esports mode](docs/esports-series.md) | `EsportsSeries`: series formats, identifying teams and players, series results. |
| [Type guards](docs/type-guards.md) | Validating messages, `parseEventMessage`, guard building blocks. |
| [Examples](examples/) | Runnable scripts: basic usage, commands, esports. |
| [Changelog](CHANGELOG.md) | Changes between versions. |

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

CI runs the same checks on every pull request, on Node.js 22 and 24, on Linux and Windows.

## License

MIT. This project is not affiliated with Psyonix or Epic Games.
