# Type guards

[← Docs index](README.md) · [README](../README.md)

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

## What the guards accept

Guards accept extra, undocumented fields, so new fields added by a game update don't break validation. Fields the docs mark `SPECTATOR` or `CONDITIONAL` (and `MatchGuid`, which is only set online or on LAN) are optional.

## Building blocks

The building blocks (`shape`, `optional`, `arrayOf`, `oneOf`, `isString`, `isNumber`, …) are exported too, so you can write guards for your own types the same way.

## Sending events on

`serializeEvent(event)` is the inverse of `parseEventMessage`: the event as the game sends it, to relay it to other programs or to fake the game in tests.

```ts
client.onAny((event) => socket.send(serializeEvent(event)));
```
