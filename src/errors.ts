/** Base class for every error thrown or emitted by this library. */
export class StatsApiError extends Error {
	override name = 'StatsApiError';
}

/** Thrown by `send()` when the socket is not open. */
export class NotConnectedError extends StatsApiError {
	override name = 'NotConnectedError';
	constructor(message = 'Cannot send a command: the socket is not connected.') {
		super(message);
	}
}

/** Thrown by `send()` when a command name or payload fails validation. */
export class CommandValidationError extends StatsApiError {
	override name = 'CommandValidationError';
	constructor(
		message: string,
		/** The command name that was passed. */
		readonly command: unknown,
		/** The payload that was passed. */
		readonly data: unknown,
	) {
		super(message);
	}
}

/** Emitted on `error` when the WebSocket reports a failure. */
export class ConnectionError extends StatsApiError {
	override name = 'ConnectionError';
}

/** Emitted on `error` when an event listener throws. */
export class ListenerError extends StatsApiError {
	override name = 'ListenerError';
	constructor(
		/** The listener event name that was being dispatched. */
		readonly eventName: string,
		cause: unknown,
	) {
		super(`A listener for "${eventName}" threw an error.`, { cause });
	}
}
