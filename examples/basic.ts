/**
 * Run with: npx tsx examples/basic.ts
 * Requires Rocket League running with the Stats API enabled (see README).
 */
import { RocketLeagueStatsClient } from '../src/node.js';

// Connects to ws://127.0.0.1:49124 automatically and enables PacketSendRate in the .ini if needed.
const client = new RocketLeagueStatsClient();

client.on('connect', () => console.log('Connected to Rocket League'));
client.on('disconnect', ({ willReconnect }) => console.log(`Disconnected (reconnecting: ${willReconnect})`));
client.on('error', (error) => console.error(error.message));
client.on('invalidMessage', (failure) => console.warn(`Invalid message (${failure.reason})`, failure.event));

client.on('GoalScored', (data) => {
	const assist = data.Assister ? ` (assist: ${data.Assister.Name})` : '';
	console.log(`GOAL by ${data.Scorer.Name}${assist} at ${data.GoalSpeed.toFixed(0)} uu/s`);
});

client.onAny((event) => {
	switch (event.Event) {
		case 'UpdateState':
			return; // high frequency, skip
		case 'StatfeedEvent':
			console.log(`[stat] ${event.Data.MainTarget.Name}: ${event.Data.EventName}`);
			return;
		default:
			console.log(`[event] ${event.Event}`);
	}
});

// Commands: typed and validated before sending.
client.on('RoundStarted', () => {
	client.send('ChangePOV', { Focus: 'Ball', Perspective: 'AutoCam' });
});
