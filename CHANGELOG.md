# Changelog

All notable changes to `@juande_pl/rocketleague-stats-api-client` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `MatchTracker` tracks live stats of the current match ([#11]):
  - **Ball possession:** time each team was the last to touch the ball (`Game.Ball.TeamNum`).
  - **Per player:** boost used, air time, wall time (`onWallTime`), and crossbar and post hits split into `attack` and `defense`.
  - **What counts:** only live play. Kickoff countdowns and goal replays are excluded, and overtime is counted. While the match is paused, everything is frozen (`tracker.paused`).
  - **Match summary:** on `MatchEnded` it emits a `MatchSummary` with the teams, winner, overtime flag and MVP. `playerResults` holds each player's `PrimaryId`, scoreboard and tracked stats.
- Players who leave before the end (anti rage quit) stay in `playerResults` with `leftEarly: true` and their stats until they left ([#11]):
  - `leftAt` says when they left.
  - They can't be MVP.
- Match timeline ([#11]):
  - Every event except `UpdateState` is kept with its `MatchMoment`: clock, play time, date and order.
  - `MatchSummary` has `timeline`, `endMoment` and `goals`.
  - Live, use `tracker.getTimeline()` and `tracker.getMoment()`.
- Timing helpers ([#11]):
  - `timeFromPlayerLeftToMatchEnd`, `timeFromPlayerLeftToNextGoal` and `timeFromPlayerLeftTo` (any event, with an optional filter).
  - `findEventAfter` and `timeBetween`.
  - Each time difference is given as play time, clock time and real time.
- `EsportsSeries`, the esports mode: records series of matches in memory ([#11]).
  - **Options:** `games` (default 5) and `format` (`'best-of'` or `'play-all'`).
  - **`autoStart`:** on by default. The series records without calling `start()`, and a new one starts after each series ends.
  - **Controls:** `start()`, `restart()` and `stop()`.
  - **Results:** per team, per player and per match. Also the series winner and MVP.
  - **Listeners:** `onSeriesStart`, `onMatchEnd` and `onSeriesEnd`.
- General helpers ([#11]):
  - `getMvp`, `getTopPlayer` and `getTeamTotals`.
  - `formatMatchClock`, which gives `"02:35"` / `"+01:10"` by default, or `"2:35"` with `{ padMinutes: false }`.
- `examples/esports.ts` records series and prints the stats of each match and player ([#11]).
- CI with GitHub Actions: typecheck, tests, build and package check on Node.js 22 and 24, on Linux and Windows ([#12]).
- This changelog ([#12]).

### Not included

- **Field domination** (time the ball spends in each half): `UpdateState` doesn't send the ball position. It will be added if a future Stats API update includes it.

## [1.1.0] - 2026-11-14

### Added

- `sortPlayers(players, ...comparators)` returns a sorted copy of a player list. The sort is stable, and later comparators break ties ([#9]).
- Comparators `byTeam()`, `byShortcut()`, `byName()` and `byStat(stat)`. Each one takes `'asc'` or `'desc'` ([#9]).
- Client option `sortPlayers` sorts `UpdateState.Players` before listeners get them. Without it, players keep the order the game sends ([#9]).
- Client option `ignoreReplayEndGoal` and helper `isReplayEndGoal(event)` ([#7]).

### Changed

- **The fake `GoalScored` event the game sends when a replay ends is now dropped by default.** Its scorer is `{ Name: '', Shortcut: 0, TeamNum: 0 }`. Pass `ignoreReplayEndGoal: false` to receive it ([#7]).

## [1.0.0] - 2026-11-12

First stable release, published as `@juande_pl/rocketleague-stats-api-client`.

### Added

- `RocketLeagueStatsClient`, a typed WebSocket client for the Rocket League Stats API:
  - `on()`, `once()`, `onAny()`, `waitFor()` and `send()`.
  - It connects automatically and reconnects with exponential backoff.
- Types for all 22 events and 6 commands, with a runtime type guard for each one. Validation is on by default, and invalid messages are reported on `invalidMessage`.
- Commands are checked at compile time and at runtime before being sent. `send()` throws `CommandValidationError` or `NotConnectedError`.
- Automatic Stats API setup on Node.js:
  - The client looks for `TAStatsAPI.ini`, or `DefaultStatsAPI.ini` if it doesn't exist. On Windows it finds Epic Games and Steam installs by itself.
  - If `PacketSendRate` is `0` or less, missing, or above `120`, it sets it to `30` and warns that the game must be restarted.
  - Turn it off with `ensureStatsApi: false`.
  - The helpers (`ensureStatsApiEnabled`, `editPacketSendRate`) are exported from `@juande_pl/rocketleague-stats-api-client/node` ([#1], [#2]).
- Browser support. There, the `.ini` check is skipped and the Node-only code is never loaded.
- ESM and CommonJS builds. No runtime dependencies. Requires Node.js >= 22.
- Examples: `examples/basic.ts` and `examples/commands.ts`.

### Changed

- The package was renamed from `rocketleague-stats-api-client` to `@juande_pl/rocketleague-stats-api-client`.

[Unreleased]: https://github.com/JuandePL/rocketleague-stats-api-client/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/JuandePL/rocketleague-stats-api-client/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/JuandePL/rocketleague-stats-api-client/releases/tag/v1.0.0
[#1]: https://github.com/JuandePL/rocketleague-stats-api-client/pull/1
[#2]: https://github.com/JuandePL/rocketleague-stats-api-client/pull/2
[#7]: https://github.com/JuandePL/rocketleague-stats-api-client/pull/7
[#9]: https://github.com/JuandePL/rocketleague-stats-api-client/pull/9
[#11]: https://github.com/JuandePL/rocketleague-stats-api-client/pull/11
[#12]: https://github.com/JuandePL/rocketleague-stats-api-client/pull/12
