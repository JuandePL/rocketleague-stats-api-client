/**
 * Interactive console that sends commands to Rocket League.
 *
 * Run with: npx tsx examples/commands.ts
 * Requires Rocket League running with the Stats API enabled (see README).
 * Most commands only work while spectating a match or watching a replay.
 */
import { createInterface } from 'node:readline/promises';
import {
	CommandValidationError,
	NotConnectedError,
	PERSPECTIVES,
	RocketLeagueStatsClient,
	type Focus,
	type Perspective,
	type StatsApiCommand,
} from '../src/node.js';

const HELP = `
Commands:
  pov <ball|N> [perspective]   Focus the ball or player shortcut N (e.g. "pov 1 HardAttach")
  cam <perspective>            Change only the perspective (${PERSPECTIVES.join(', ')})
  pause | resume               Pause or resume the match/replay
  speed <multiplier>           Replay speed (1 = normal, 0.5 = half, 2 = double)
  seek <seconds> | frame <N>   Jump to a time or a frame in the replay
  replay <file name or path>   Load a replay (a path if it contains / or \\)
  hud <on|off>                 Show or hide the HUD
  demo                         Run a short scripted sequence
  help | exit
`;

const client = new RocketLeagueStatsClient();

client.on('connect', () => console.log('Connected to Rocket League. Type "help" for the command list.'));
client.on('disconnect', ({ willReconnect }) => console.log(`Disconnected (reconnecting: ${willReconnect})`));
client.on('error', (error) => console.error(`[error] ${error.message}`));

const isPerspective = (value: string): value is Perspective => (PERSPECTIVES as readonly string[]).includes(value);

/** Turns one console line into a typed command envelope. Throws a readable error for bad input. */
function parseLine(line: string): StatsApiCommand {
	const [name = '', ...args] = line.trim().split(/\s+/);
	const arg = args.join(' ');

	switch (name.toLowerCase()) {
		case 'pov': {
			const [target = '', perspective] = args;
			const focus: Focus = target.toLowerCase() === 'ball' ? 'Ball' : (target as `${number}`);
			if (perspective !== undefined && !isPerspective(perspective)) throw new Error(`Unknown perspective "${perspective}".`);
			return { Command: 'ChangePOV', Data: { Focus: focus, Perspective: perspective } };
		}
		case 'cam':
			if (!isPerspective(arg)) throw new Error(`Unknown perspective "${arg}".`);
			return { Command: 'ChangePOV', Data: { Perspective: arg } };
		case 'pause':
			return { Command: 'SetMatchPaused', Data: { bPaused: true } };
		case 'resume':
			return { Command: 'SetMatchPaused', Data: { bPaused: false } };
		case 'speed':
			return { Command: 'SetGameSpeed', Data: { Speed: Number(arg) } };
		case 'seek':
			return { Command: 'SeekReplay', Data: { TimeSeconds: Number(arg) } };
		case 'frame':
			return { Command: 'SeekReplay', Data: { Frame: Number(arg) } };
		case 'replay':
			return { Command: 'LoadReplay', Data: /[\\/]/.test(arg) ? { Path: arg } : { FileName: arg } };
		case 'hud':
			if (arg !== 'on' && arg !== 'off') throw new Error('Use "hud on" or "hud off".');
			return { Command: 'SetHUDVisibility', Data: { bVisible: arg === 'on' } };
		default:
			throw new Error(`Unknown command "${name}". Type "help".`);
	}
}

/** Sends a command and explains the two errors `send()` can throw. */
function trySend(command: StatsApiCommand): void {
	try {
		client.send(command);
		console.log(`-> ${JSON.stringify(command)}`);
	} catch (error) {
		if (error instanceof NotConnectedError) console.error('Not connected yet. Is the game running?');
		else if (error instanceof CommandValidationError) console.error(`Rejected before sending: ${error.message}`, error.data);
		else throw error;
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A scripted sequence using the `send(name, data)` form, which is type-checked at compile time. */
async function demo(): Promise<void> {
	const steps: Array<[string, () => void]> = [
		['Ball cam', () => client.send('ChangePOV', { Focus: 'Ball', Perspective: 'SoftAttach' })],
		['Player 1 view', () => client.send('ChangePOV', { Focus: '1' })],
		['Hide HUD', () => client.send('SetHUDVisibility', { bVisible: false })],
		['Slow motion', () => client.send('SetGameSpeed', { Speed: 0.25 })],
		['Normal speed', () => client.send('SetGameSpeed', { Speed: 1 })],
		['Show HUD', () => client.send('SetHUDVisibility', { bVisible: true })],
		['Auto camera', () => client.send('ChangePOV', { Perspective: 'AutoCam' })],
	];
	for (const [label, run] of steps) {
		console.log(`[demo] ${label}`);
		try {
			run();
		} catch (error) {
			console.error(`[demo] ${(error as Error).message}`);
			return;
		}
		await sleep(2000);
	}
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
for await (const line of rl) {
	const input = line.trim();
	if (!input) continue;
	if (input === 'exit') break;
	if (input === 'help') {
		console.log(HELP);
		continue;
	}
	if (input === 'demo') {
		await demo();
		continue;
	}
	try {
		trySend(parseLine(input));
	} catch (error) {
		console.error((error as Error).message);
	}
}

rl.close();
client.disconnect();
