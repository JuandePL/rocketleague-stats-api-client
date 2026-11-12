# rocketleague-stats-api-client

Fully typed WebSocket client for the official [Rocket League Stats API](https://www.rocketleague.com/developer/stats-api), with runtime type guards for every event and command.

- Typed interfaces for all 22 events and 6 commands
- Type guards that validate each message at runtime (enabled by default)
- `RocketLeagueStatsClient`: connects automatically, reconnects with backoff, and gives you typed `on()` / `onAny()` / `send()`
- No runtime dependencies. Works in Node.js >= 22 and in browsers. ESM and CommonJS builds.

## Install

```sh
npm install rocketleague-stats-api-client
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

Import the client from `rocketleague-stats-api-client/node` and it checks the `.ini` for you. It looks for `TAStatsAPI.ini` first, then `DefaultStatsAPI.ini`. On Windows it finds the Epic Games and Steam installs by itself. If `PacketSendRate` is `0` or less (or missing), it sets it to `30` and warns that **you must restart the game** for the Stats API to work. The game only reads this file at launch.

```ts
import { RocketLeagueStatsClient } from 'rocketleague-stats-api-client/node';

const client = new RocketLeagueStatsClient({
  ensureStatsApi: true, // default. Or false, or { installDir, iniPath, packetSendRate, warn }
});

const config = await client.statsApiConfig;
// { status: 'updated', iniPath, previous: 0, packetSendRate: 30, restartRequired: true }
// or 'enabled' | 'not-found' | 'write-failed' (e.g. no permission under Program Files)
```

You can also run the check on its own with `ensureStatsApiEnabled(options)`. Use `editPacketSendRate(content)` to edit the `.ini` text without touching the disk. The main entry stays free of Node APIs, so it still works in browsers.

## Usage

```ts
import { RocketLeagueStatsClient } from "rocketleague-stats-api-client";

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
  WebSocket: undefined,  // custom implementation, defaults to globalThis.WebSocket
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

## Type guards

Every guard is exported, so you can validate messages from any source (the TCP port, recordings, a relay server…):

```ts
import { isStatsApiEvent, isGoalScoredData, isEventData, isStatsApiCommand, parseEventMessage } from 'rocketleague-stats-api-client';

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

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

## License

MIT. This project is not affiliated with Psyonix or Epic Games.
