import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	CommandValidationError,
	NotConnectedError,
	RocketLeagueStatsClient,
	type StatsApiClientOptions,
	type StatsApiEvent,
	type WebSocketLike,
} from '../src/index.js';
import { fixtures, wire } from './fixtures.js';

type Handler = (event: any) => void;

/** Minimal in-memory WebSocket used to drive the client. */
class FakeWebSocket implements WebSocketLike {
	static instances: FakeWebSocket[] = [];
	readyState = 0;
	sent: string[] = [];
	readonly handlers = new Map<string, Handler[]>();

	constructor(readonly url: string) {
		FakeWebSocket.instances.push(this);
	}
	addEventListener(type: string, listener: Handler): void {
		this.handlers.set(type, [...(this.handlers.get(type) ?? []), listener]);
	}
	send(data: string): void {
		this.sent.push(data);
	}
	close(code = 1000, reason = ''): void {
		this.serverClose(code, reason);
	}
	// --- test helpers ---
	fire(type: string, event?: unknown): void {
		for (const h of this.handlers.get(type) ?? []) h(event);
	}
	open(): void {
		this.readyState = 1;
		this.fire('open');
	}
	message(data: unknown): void {
		this.fire('message', { data });
	}
	serverClose(code = 1006, reason = ''): void {
		this.readyState = 3;
		this.fire('close', { code, reason });
	}
	static last(): FakeWebSocket {
		const ws = FakeWebSocket.instances.at(-1);
		if (!ws) throw new Error('no socket created');
		return ws;
	}
}

function createClient(options: StatsApiClientOptions = {}) {
	return new RocketLeagueStatsClient({ WebSocket: FakeWebSocket, ...options });
}

beforeEach(() => {
	FakeWebSocket.instances = [];
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('connection', () => {
	it('auto-connects to the default WebPort on the next microtask', async () => {
		const client = createClient();
		const onConnect = vi.fn();
		client.on('connect', onConnect);
		expect(FakeWebSocket.instances).toHaveLength(0);
		await Promise.resolve();
		expect(FakeWebSocket.last().url).toBe('ws://127.0.0.1:49124');
		FakeWebSocket.last().open();
		expect(onConnect).toHaveBeenCalledOnce();
		expect(client.isConnected).toBe(true);
		expect(client.state).toBe('open');
	});

	it('does not connect when autoConnect is false', async () => {
		const client = createClient({ autoConnect: false, host: 'localhost', port: 1234 });
		await Promise.resolve();
		expect(FakeWebSocket.instances).toHaveLength(0);
		expect(client.state).toBe('idle');
		client.connect();
		expect(FakeWebSocket.last().url).toBe('ws://localhost:1234');
	});

	it('does not auto-connect if disconnect() is called first', async () => {
		const client = createClient();
		client.disconnect();
		await Promise.resolve();
		expect(FakeWebSocket.instances).toHaveLength(0);
	});

	it('ignores connect() while already connecting', () => {
		const client = createClient({ autoConnect: false });
		client.connect();
		client.connect();
		expect(FakeWebSocket.instances).toHaveLength(1);
	});

	it('reconnects with exponential backoff and resets after a successful open', async () => {
		const client = createClient({ autoConnect: false, reconnect: { initialDelay: 100, factor: 2, maxDelay: 300 } });
		const reconnecting = vi.fn();
		const disconnect = vi.fn();
		client.on('reconnecting', reconnecting);
		client.on('disconnect', disconnect);

		client.connect();
		FakeWebSocket.last().serverClose();
		await Promise.resolve();
		expect(disconnect).toHaveBeenLastCalledWith({ code: 1006, reason: '', willReconnect: true });
		expect(reconnecting).toHaveBeenLastCalledWith({ attempt: 1, delay: 100 });

		vi.advanceTimersByTime(100);
		expect(FakeWebSocket.instances).toHaveLength(2);
		FakeWebSocket.last().serverClose();
		await Promise.resolve();
		expect(reconnecting).toHaveBeenLastCalledWith({ attempt: 2, delay: 200 });

		vi.advanceTimersByTime(200);
		FakeWebSocket.last().serverClose();
		await Promise.resolve();
		expect(reconnecting).toHaveBeenLastCalledWith({ attempt: 3, delay: 300 });

		vi.advanceTimersByTime(300);
		FakeWebSocket.last().open();
		FakeWebSocket.last().serverClose();
		await Promise.resolve();
		expect(reconnecting).toHaveBeenLastCalledWith({ attempt: 1, delay: 100 });
	});

	it('stops after maxAttempts', async () => {
		const client = createClient({ autoConnect: false, reconnect: { initialDelay: 10, maxAttempts: 1 } });
		const disconnect = vi.fn();
		client.on('disconnect', disconnect);
		client.connect();
		FakeWebSocket.last().serverClose();
		vi.advanceTimersByTime(10);
		FakeWebSocket.last().serverClose();
		expect(disconnect).toHaveBeenLastCalledWith(expect.objectContaining({ willReconnect: false }));
		vi.advanceTimersByTime(10_000);
		expect(FakeWebSocket.instances).toHaveLength(2);
	});

	it('does not reconnect after disconnect()', () => {
		const client = createClient({ autoConnect: false });
		const disconnect = vi.fn();
		client.on('disconnect', disconnect);
		client.connect();
		FakeWebSocket.last().open();
		client.disconnect();
		expect(disconnect).toHaveBeenCalledWith({ code: 1000, reason: 'Client disconnect', willReconnect: false });
		vi.advanceTimersByTime(60_000);
		expect(FakeWebSocket.instances).toHaveLength(1);
		expect(client.state).toBe('closed');
	});

	it('does not reconnect when reconnect is false', () => {
		const client = createClient({ autoConnect: false, reconnect: false });
		client.connect();
		FakeWebSocket.last().serverClose();
		vi.advanceTimersByTime(60_000);
		expect(FakeWebSocket.instances).toHaveLength(1);
	});

	it('emits socket errors as ConnectionError', () => {
		const client = createClient({ autoConnect: false });
		const onError = vi.fn();
		client.on('error', onError);
		client.connect();
		FakeWebSocket.last().fire('error', new Event('error'));
		expect(onError.mock.calls[0]?.[0]).toMatchObject({ name: 'ConnectionError' });
	});
});

describe('events', () => {
	function connected(options: StatsApiClientOptions = {}) {
		const client = createClient({ autoConnect: false, ...options });
		client.connect();
		const ws = FakeWebSocket.last();
		ws.open();
		return { client, ws };
	}

	it('dispatches typed events to specific listeners', () => {
		const { client, ws } = connected();
		const onGoal = vi.fn();
		client.on('GoalScored', (data, event) => {
			onGoal(data.Scorer.Name, data.Assister?.Name, event.Event);
		});
		ws.message(wire('GoalScored', fixtures.GoalScored));
		expect(onGoal).toHaveBeenCalledWith('PlayerA', 'PlayerC', 'GoalScored');
	});

	it('dispatches every event to onAny', () => {
		const { client, ws } = connected();
		const seen: StatsApiEvent[] = [];
		client.onAny((event) => seen.push(event));
		ws.message(wire('UpdateState', fixtures.UpdateState));
		ws.message(wire('StatfeedEvent', fixtures.StatfeedEvent));
		expect(seen.map((e) => e.Event)).toEqual(['UpdateState', 'StatfeedEvent']);
		const statfeed = seen[1]!;
		if (statfeed.Event === 'StatfeedEvent') expect(statfeed.Data.EventName).toBe('Demolish');
	});

	it('decodes binary frames', () => {
		const { client, ws } = connected();
		const onEnded = vi.fn();
		client.on('MatchEnded', onEnded);
		ws.message(new TextEncoder().encode(wire('MatchEnded', fixtures.MatchEnded)));
		expect(onEnded).toHaveBeenCalledWith(fixtures.MatchEnded, { Event: 'MatchEnded', Data: fixtures.MatchEnded });
	});

	it('reports invalid messages and does not dispatch them', () => {
		const { client, ws } = connected();
		const onAny = vi.fn();
		const onInvalid = vi.fn();
		client.onAny(onAny);
		client.on('invalidMessage', onInvalid);
		ws.message(wire('MatchEnded', { WinnerTeamNum: 'blue' }));
		ws.message(wire('Mystery', {}));
		ws.message('garbage');
		expect(onAny).not.toHaveBeenCalled();
		expect(onInvalid.mock.calls.map((c) => c[0].reason)).toEqual(['invalid-data', 'unknown-event', 'invalid-json']);
	});

	it('dispatches unvalidated payloads when validateEvents is false', () => {
		const { client, ws } = connected({ validateEvents: false });
		const onEnded = vi.fn();
		client.on('MatchEnded', onEnded);
		ws.message(wire('MatchEnded', { WinnerTeamNum: 'blue' }));
		expect(onEnded).toHaveBeenCalledOnce();
	});

	it('supports off, once, unsubscribe and waitFor', async () => {
		const { client, ws } = connected();
		const a = vi.fn();
		const b = vi.fn();
		const c = vi.fn();
		const unsubscribe = client.on('RoundStarted', a);
		client.once('RoundStarted', b);
		client.on('RoundStarted', c);
		client.off('RoundStarted', c);
		const waited = client.waitFor('RoundStarted');

		ws.message(wire('RoundStarted', {}));
		unsubscribe();
		ws.message(wire('RoundStarted', {}));

		expect(a).toHaveBeenCalledOnce();
		expect(b).toHaveBeenCalledOnce();
		expect(c).not.toHaveBeenCalled();
		await expect(waited).resolves.toEqual({});
	});

	it('waitFor rejects on timeout', async () => {
		const { client } = connected();
		const waited = client.waitFor('GoalScored', { timeout: 50 });
		vi.advanceTimersByTime(50);
		await expect(waited).rejects.toThrow(/Timed out/);
	});

	it('isolates throwing listeners and reports them on error', () => {
		const { client, ws } = connected();
		const onError = vi.fn();
		const after = vi.fn();
		client.on('error', onError);
		client.on('RoundStarted', () => {
			throw new Error('boom');
		});
		client.on('RoundStarted', after);
		ws.message(wire('RoundStarted', {}));
		expect(after).toHaveBeenCalledOnce();
		expect(onError.mock.calls[0]?.[0]).toMatchObject({ name: 'ListenerError', eventName: 'RoundStarted' });
	});

	it('handleMessage accepts messages from other sources', () => {
		const client = createClient({ autoConnect: false });
		const onCountdown = vi.fn();
		client.on('CountdownBegin', onCountdown);
		client.handleMessage(wire('CountdownBegin', fixtures.CountdownBegin));
		expect(onCountdown).toHaveBeenCalledOnce();
	});
});

describe('send', () => {
	function connected() {
		const client = createClient({ autoConnect: false });
		client.connect();
		const ws = FakeWebSocket.last();
		ws.open();
		return { client, ws };
	}

	it('sends a validated command envelope', () => {
		const { client, ws } = connected();
		client.send('ChangePOV', { Focus: '1', Perspective: 'PlayerView' });
		client.send({ Command: 'SetHUDVisibility', Data: { bVisible: false } });
		expect(ws.sent.map((s) => JSON.parse(s))).toEqual([
			{ Command: 'ChangePOV', Data: { Focus: '1', Perspective: 'PlayerView' } },
			{ Command: 'SetHUDVisibility', Data: { bVisible: false } },
		]);
	});

	it('throws CommandValidationError on invalid input (checked before the connection)', () => {
		const client = createClient({ autoConnect: false });
		// Runtime check for callers that bypass the types (plain JS, `any`, ...).
		const untyped = client as unknown as { send(...args: unknown[]): void };
		expect(() => untyped.send('Explode', {})).toThrow(CommandValidationError);
		expect(() => untyped.send('SetGameSpeed', { Speed: -2 })).toThrow(CommandValidationError);
		expect(() => untyped.send('ChangePOV', { Focus: 'PlayerA' })).toThrow(CommandValidationError);
		expect(() => untyped.send({ Command: 'SeekReplay', Data: {} })).toThrow(CommandValidationError);
	});

	it('throws NotConnectedError when the socket is not open', () => {
		const client = createClient({ autoConnect: false });
		expect(() => client.send('SetMatchPaused', { bPaused: true })).toThrow(NotConnectedError);
	});

	it('rejects invalid payloads at compile time', () => {
		const { client } = connected();
		const attempt = (fn: () => void) => expect(fn).toThrow(CommandValidationError);
		// @ts-expect-error -- at least one of Focus / Perspective is required
		attempt(() => client.send('ChangePOV', {}));
		// @ts-expect-error -- Focus must be "Ball" or a numeric string
		attempt(() => client.send('ChangePOV', { Focus: 'PlayerA' }));
		// @ts-expect-error -- unknown command
		attempt(() => client.send('Explode', {}));
		// @ts-expect-error -- wrong payload type
		attempt(() => client.send('SetMatchPaused', { bPaused: 'yes' }));
		// @ts-expect-error -- payload of another command
		attempt(() => client.send({ Command: 'SetGameSpeed', Data: { bVisible: true } }));
	});
});

describe('type-level listener checks', () => {
	it('types listener arguments from the event name', () => {
		const client = createClient({ autoConnect: false });
		client.on('BallHit', (data) => {
			const speed: number = data.Ball.PostHitSpeed;
			void speed;
			// @ts-expect-error -- BallHit has no Scorer
			void data.Scorer;
		});
		client.on('disconnect', (info) => {
			const flag: boolean = info.willReconnect;
			void flag;
		});
		// @ts-expect-error -- unknown event name
		client.on('NotAnEvent', () => {});
		expect(true).toBe(true);
	});
});
