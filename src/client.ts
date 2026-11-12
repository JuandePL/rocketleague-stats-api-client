import { CommandValidationError, ConnectionError, ListenerError, NotConnectedError } from './errors.js';
import { isCommandData, isCommandName, isStatsApiCommand } from './guards/commands.js';
import { isRecord } from './guards/primitives.js';
import { parseEventMessage, type ParseFailure } from './parse.js';
import type { CommandDataMap, CommandName, StatsApiCommand } from './types/commands.js';
import type { EventDataMap, EventName, StatsApiEvent, StatsApiEventOf } from './types/events.js';
import type { EnsureStatsApiOptions, EnsureStatsApiResult } from './node/config.js';

// ---------------------------------------------------------------------------
// WebSocket abstraction
// ---------------------------------------------------------------------------

/**
 * The subset of the standard `WebSocket` API this client relies on.
 * Satisfied by the browser/Node.js (>= 22) global `WebSocket` and by the `ws` package.
 */
export interface WebSocketLike {
	readonly readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: 'open', listener: () => void): void;
	addEventListener(type: 'close', listener: (event: { code: number; reason: string }) => void): void;
	addEventListener(type: 'error', listener: (event: unknown) => void): void;
	addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

/** A constructor producing a {@link WebSocketLike}. */
export type WebSocketConstructor = new (url: string) => WebSocketLike;

const WS_OPEN = 1;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ReconnectOptions {
	/** Delay before the first reconnection attempt, in ms. @default 1000 */
	initialDelay?: number;
	/** Upper bound for the delay between attempts, in ms. @default 30000 */
	maxDelay?: number;
	/** Multiplier applied to the delay after every failed attempt. @default 2 */
	factor?: number;
	/** Maximum consecutive attempts before giving up. @default Infinity */
	maxAttempts?: number;
}

export interface StatsApiClientOptions {
	/** Host of the Rocket League client. @default '127.0.0.1' */
	host?: string;
	/** The `WebPort` configured in `TAStatsAPI.ini`. @default 49124 */
	port?: number;
	/** Use `wss://` instead of `ws://`. @default false */
	secure?: boolean;
	/** Full WebSocket URL. Overrides `host`, `port` and `secure` when set. */
	url?: string;
	/**
	 * Connect automatically after construction. Set to `false` to call {@link RocketLeagueStatsClient.connect} yourself.
	 * The connection starts on the next microtask, so listeners attached right after `new` still receive `connect`.
	 * @default true
	 */
	autoConnect?: boolean;
	/**
	 * Reconnect automatically when the connection drops or cannot be established
	 * (e.g. the game is not running yet). `false` disables it.
	 * @default true
	 */
	reconnect?: boolean | ReconnectOptions;
	/**
	 * Validate every incoming event with its type guard. Invalid events are not dispatched
	 * and are reported on `invalidMessage` instead.
	 * @default true
	 */
	validateEvents?: boolean;
	/**
	 * WebSocket implementation. Defaults to `globalThis.WebSocket`
	 * (browsers, Node.js >= 22). Pass `WebSocket` from the `ws` package for older runtimes.
	 */
	WebSocket?: WebSocketConstructor;
	/**
	 * **Node.js only** (ignored in browsers). Check the Stats API `.ini` file (`TAStatsAPI.ini`, else
	 * `DefaultStatsAPI.ini`) on construction and, if `PacketSendRate` is `0` or less, set it to `30` and
	 * warn that the game must be restarted. Pass options to customize it, or `false` to disable it.
	 * @default true
	 */
	ensureStatsApi?: boolean | EnsureStatsApiOptions;
}

/** `true` when running on Node.js (where the `.ini` file can be read). */
function isNodeRuntime(): boolean {
	const proc = (globalThis as { process?: { versions?: { node?: unknown } } }).process;
	return typeof proc?.versions?.node === 'string';
}

// ---------------------------------------------------------------------------
// Listener types
// ---------------------------------------------------------------------------

/** Connection state of the client. */
export type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed';

export interface DisconnectInfo {
	code: number;
	reason: string;
	/** `true` when a reconnection attempt has been scheduled. */
	willReconnect: boolean;
}

export interface ReconnectInfo {
	/** 1-based attempt number. */
	attempt: number;
	/** Delay before this attempt, in ms. */
	delay: number;
}

/** Listener for a specific game event. Receives the typed payload and the whole decoded message. */
export type GameEventListener<E extends EventName> = (data: EventDataMap[E], event: StatsApiEventOf<E>) => void;

/** Listener receiving every game event as a discriminated union. */
export type AnyEventListener = (event: StatsApiEvent) => void;

/** Client lifecycle events (lowercase, so they never collide with game events). */
export interface LifecycleListenerMap {
	/** The socket is open. */
	connect: () => void;
	/** The socket closed. */
	disconnect: (info: DisconnectInfo) => void;
	/** A reconnection attempt has been scheduled. */
	reconnecting: (info: ReconnectInfo) => void;
	/** A connection error or a listener error happened. */
	error: (error: Error) => void;
	/** A message could not be decoded, has an unknown event name, or failed validation. */
	invalidMessage: (failure: ParseFailure) => void;
}

/** Every listener accepted by {@link RocketLeagueStatsClient.on}. */
export type ClientListenerMap = { [E in EventName]: GameEventListener<E> } & LifecycleListenerMap;

/** Any name accepted by {@link RocketLeagueStatsClient.on}. */
export type ClientEventName = keyof ClientListenerMap;

/** Call it to remove the listener. */
export type Unsubscribe = () => void;

type AnyFunction = (...args: never[]) => void;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * WebSocket client for the Rocket League Stats API.
 *
 * ```ts
 * const client = new RocketLeagueStatsClient();
 *
 * client.on('GoalScored', (data) => console.log(`${data.Scorer.Name} scored!`));
 * client.onAny((event) => console.log(event.Event));
 * client.send('ChangePOV', { Focus: 'Ball' });
 * ```
 *
 * @see https://www.rocketleague.com/developer/stats-api
 */
export class RocketLeagueStatsClient {
	/** The WebSocket URL this client connects to. */
	readonly url: string;

	/**
	 * Result of the `.ini` check (see the `ensureStatsApi` option). `undefined` outside Node.js or when
	 * `ensureStatsApi: false`. Never rejects.
	 */
	readonly statsApiConfig: Promise<EnsureStatsApiResult> | undefined;

	readonly #autoConnect: boolean;
	readonly #reconnect: Required<ReconnectOptions> | null;
	readonly #validateEvents: boolean;
	readonly #WebSocket: WebSocketConstructor | undefined;

	#socket: WebSocketLike | null = null;
	#state: ConnectionState = 'idle';
	#manualClose = false;
	#reconnectAttempts = 0;
	#reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	readonly #listeners = new Map<string, Set<AnyFunction>>();
	readonly #anyListeners = new Set<AnyEventListener>();

	constructor(options: StatsApiClientOptions = {}) {
		const protocol = options.secure ? 'wss' : 'ws';
		this.url = options.url ?? `${protocol}://${options.host ?? '127.0.0.1'}:${options.port ?? 49124}`;
		this.#autoConnect = options.autoConnect ?? true;
		this.#validateEvents = options.validateEvents ?? true;
		this.#WebSocket = options.WebSocket ?? (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;

		const reconnect = options.reconnect ?? true;
		this.#reconnect =
			reconnect === false
				? null
				: {
						initialDelay: 1000,
						maxDelay: 30_000,
						factor: 2,
						maxAttempts: Number.POSITIVE_INFINITY,
						...(reconnect === true ? {} : reconnect),
					};

		const ensureStatsApi = options.ensureStatsApi ?? true;
		if (ensureStatsApi !== false && isNodeRuntime()) {
			const ensureOptions = ensureStatsApi === true ? {} : ensureStatsApi;
			const rate = ensureOptions.packetSendRate;
			if (rate !== undefined && !(Number.isFinite(rate) && rate > 0)) {
				throw new RangeError(`packetSendRate must be greater than 0, got ${rate}.`);
			}
			// Loaded lazily so the Node-only code (node:fs) is never evaluated in browsers.
			this.statsApiConfig = import('./node/config.js').then(({ ensureStatsApiEnabled }) => ensureStatsApiEnabled(ensureOptions));
		} else {
			this.statsApiConfig = undefined;
		}

		if (this.#autoConnect) {
			queueMicrotask(() => {
				if (this.#state === 'idle' && !this.#manualClose) this.connect();
			});
		}
	}

	/** Current connection state. */
	get state(): ConnectionState {
		return this.#state;
	}

	/** `true` when the socket is open and commands can be sent. */
	get isConnected(): boolean {
		return this.#state === 'open' && this.#socket?.readyState === WS_OPEN;
	}

	// -----------------------------------------------------------------------
	// Connection
	// -----------------------------------------------------------------------

	/**
	 * Opens the connection. Does nothing if already connecting or connected.
	 * Called automatically unless `autoConnect: false` was passed.
	 */
	connect(): void {
		if (this.#state === 'connecting' || this.#state === 'open') return;
		this.#manualClose = false;
		this.#clearReconnectTimer();

		const WebSocketImpl = this.#WebSocket;
		if (!WebSocketImpl) {
			throw new ConnectionError(
				'No WebSocket implementation found. Use Node.js >= 22, or pass one via the `WebSocket` option (e.g. from the "ws" package).',
			);
		}

		this.#state = 'connecting';
		let socket: WebSocketLike;
		try {
			socket = new WebSocketImpl(this.url);
		} catch (cause) {
			this.#state = 'closed';
			this.#emitError(new ConnectionError(`Failed to create WebSocket for ${this.url}.`, { cause }));
			this.#scheduleReconnect();
			return;
		}
		this.#socket = socket;

		socket.addEventListener('open', () => {
			if (this.#socket !== socket) return;
			this.#state = 'open';
			this.#reconnectAttempts = 0;
			this.#emit('connect');
		});
		socket.addEventListener('message', (event) => {
			if (this.#socket !== socket) return;
			void this.#handleRawMessage(event.data);
		});
		socket.addEventListener('error', (cause) => {
			if (this.#socket !== socket) return;
			this.#emitError(new ConnectionError(`WebSocket error on ${this.url}.`, { cause }));
		});
		socket.addEventListener('close', (event) => {
			if (this.#socket !== socket) return;
			this.#socket = null;
			this.#state = 'closed';
			const willReconnect = this.#scheduleReconnect(true);
			this.#emit('disconnect', { code: event.code, reason: event.reason, willReconnect });
		});
	}

	/** Closes the connection and stops any pending reconnection. */
	disconnect(code = 1000, reason = 'Client disconnect'): void {
		this.#manualClose = true;
		this.#clearReconnectTimer();
		const socket = this.#socket;
		if (!socket) {
			if (this.#state !== 'idle') this.#state = 'closed';
			return;
		}
		// Keep the socket attached so its `close` event still emits `disconnect`.
		socket.close(code, reason);
	}

	#scheduleReconnect(deferEmit = false): boolean {
		const options = this.#reconnect;
		if (!options || this.#manualClose || this.#reconnectAttempts >= options.maxAttempts) return false;

		const attempt = ++this.#reconnectAttempts;
		const delay = Math.min(options.initialDelay * options.factor ** (attempt - 1), options.maxDelay);
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = null;
			this.connect();
		}, delay);

		const notify = () => this.#emit('reconnecting', { attempt, delay });
		if (deferEmit) queueMicrotask(notify);
		else notify();
		return true;
	}

	#clearReconnectTimer(): void {
		if (this.#reconnectTimer !== null) {
			clearTimeout(this.#reconnectTimer);
			this.#reconnectTimer = null;
		}
	}

	// -----------------------------------------------------------------------
	// Incoming events
	// -----------------------------------------------------------------------

	async #handleRawMessage(raw: unknown): Promise<void> {
		let text: unknown = raw;
		if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
			text = new TextDecoder().decode(raw);
		} else if (typeof Blob !== 'undefined' && raw instanceof Blob) {
			text = await raw.text();
		}
		this.handleMessage(text);
	}

	/**
	 * Decodes, validates and dispatches one raw message. Called for every socket message;
	 * exposed so messages from another transport (e.g. the TCP port, a recording) can be fed in.
	 */
	handleMessage(raw: unknown): void {
		const result = parseEventMessage(raw, { validate: this.#validateEvents });
		if (!result.ok) {
			this.#emit('invalidMessage', result);
			return;
		}
		const { event } = result;
		// `event.Data` always matches `event.Event` (guaranteed by the parser), so dispatch untyped.
		this.#dispatch(event.Event, [event.Data, event]);
		for (const listener of [...this.#anyListeners]) {
			this.#invoke('*', listener, [event]);
		}
	}

	/**
	 * Listens to a game event (e.g. `'GoalScored'`) or a lifecycle event (e.g. `'connect'`).
	 * The listener's arguments are typed from the event name.
	 *
	 * @returns A function that removes the listener.
	 */
	on<K extends ClientEventName>(name: K, listener: ClientListenerMap[K]): Unsubscribe {
		let set = this.#listeners.get(name);
		if (!set) {
			set = new Set();
			this.#listeners.set(name, set);
		}
		set.add(listener as AnyFunction);
		return () => this.off(name, listener);
	}

	/** Like {@link on}, but the listener is removed after its first call. */
	once<K extends ClientEventName>(name: K, listener: ClientListenerMap[K]): Unsubscribe {
		const wrapper = ((...args: never[]) => {
			unsubscribe();
			(listener as AnyFunction)(...args);
		}) as ClientListenerMap[K];
		const unsubscribe = this.on(name, wrapper);
		return unsubscribe;
	}

	/** Removes a listener added with {@link on}. */
	off<K extends ClientEventName>(name: K, listener: ClientListenerMap[K]): void {
		this.#listeners.get(name)?.delete(listener as AnyFunction);
	}

	/**
	 * Listens to **every** game event. The argument is a discriminated union: narrow it with `event.Event`.
	 *
	 * ```ts
	 * client.onAny((event) => {
	 *   if (event.Event === 'StatfeedEvent') console.log(event.Data.EventName);
	 * });
	 * ```
	 *
	 * @returns A function that removes the listener.
	 */
	onAny(listener: AnyEventListener): Unsubscribe {
		this.#anyListeners.add(listener);
		return () => this.offAny(listener);
	}

	/** Removes a listener added with {@link onAny}. */
	offAny(listener: AnyEventListener): void {
		this.#anyListeners.delete(listener);
	}

	/** Removes every listener, or every listener of one name. */
	removeAllListeners(name?: ClientEventName): void {
		if (name === undefined) {
			this.#listeners.clear();
			this.#anyListeners.clear();
		} else {
			this.#listeners.delete(name);
		}
	}

	/**
	 * Resolves with the payload of the next occurrence of a game event.
	 * Rejects after `timeout` ms if provided.
	 */
	waitFor<E extends EventName>(name: E, options: { timeout?: number } = {}): Promise<EventDataMap[E]> {
		return new Promise((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const unsubscribe = this.once(name, ((data: EventDataMap[E]) => {
				if (timer) clearTimeout(timer);
				resolve(data);
			}) as unknown as ClientListenerMap[E]);
			if (options.timeout !== undefined) {
				timer = setTimeout(() => {
					unsubscribe();
					reject(new Error(`Timed out after ${options.timeout}ms waiting for "${name}".`));
				}, options.timeout);
			}
		});
	}

	#emit<K extends keyof LifecycleListenerMap>(name: K, ...args: Parameters<LifecycleListenerMap[K]>): void {
		this.#dispatch(name, args);
	}

	#dispatch(name: string, args: unknown[]): void {
		const set = this.#listeners.get(name);
		if (!set) return;
		for (const listener of [...set]) {
			this.#invoke(name, listener, args);
		}
	}

	#invoke(name: string, listener: AnyFunction, args: unknown[]): void {
		try {
			(listener as (...a: unknown[]) => void)(...args);
		} catch (cause) {
			if (name === 'error') return; // never loop on a failing error listener
			this.#emitError(new ListenerError(name, cause));
		}
	}

	/** Errors are only reported to `error` listeners; without one they are silently dropped. */
	#emitError(error: Error): void {
		this.#emit('error', error);
	}

	// -----------------------------------------------------------------------
	// Commands
	// -----------------------------------------------------------------------

	/**
	 * Sends a command to the game. The payload is type-checked at compile time and
	 * validated with its guard at runtime before being sent.
	 *
	 * ```ts
	 * client.send('ChangePOV', { Focus: '1', Perspective: 'PlayerView' });
	 * client.send({ Command: 'SetHUDVisibility', Data: { bVisible: false } });
	 * ```
	 *
	 * @throws {CommandValidationError} If the command name or payload is invalid.
	 * @throws {NotConnectedError} If the socket is not open.
	 */
	send<C extends CommandName>(command: C, data: CommandDataMap[C]): void;
	send(command: StatsApiCommand): void;
	send(commandOrEnvelope: CommandName | StatsApiCommand, maybeData?: unknown): void {
		const [command, data]: [unknown, unknown] =
			typeof commandOrEnvelope === 'string'
				? [commandOrEnvelope, maybeData]
				: isRecord(commandOrEnvelope)
					? [commandOrEnvelope.Command, commandOrEnvelope.Data]
					: [commandOrEnvelope, undefined];

		if (!isCommandName(command)) {
			throw new CommandValidationError(`Unknown command "${String(command)}".`, command, data);
		}
		if (!isCommandData(command, data)) {
			throw new CommandValidationError(`Invalid payload for command "${command}".`, command, data);
		}

		const envelope = { Command: command, Data: data };
		// Defensive: guarantees the envelope as a whole is valid before it reaches the game.
		if (!isStatsApiCommand(envelope)) {
			throw new CommandValidationError(`Invalid command envelope for "${command}".`, command, data);
		}

		const socket = this.#socket;
		if (!socket || !this.isConnected) throw new NotConnectedError();
		socket.send(JSON.stringify(envelope));
	}
}
