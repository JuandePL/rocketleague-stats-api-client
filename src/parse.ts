import { isEventData, isEventName } from './guards/events.js';
import { isRecord } from './guards/primitives.js';
import type { StatsApiEvent } from './types/events.js';

/** Why a message could not be turned into a {@link StatsApiEvent}. */
export type ParseFailureReason =
	/** The message is not valid JSON. */
	| 'invalid-json'
	/** The message is JSON but not an `{ Event, Data }` envelope. */
	| 'invalid-envelope'
	/** `Data` is a string that is not valid JSON, or does not decode to an object. */
	| 'invalid-data-json'
	/** `Event` is not one of the documented event names. */
	| 'unknown-event'
	/** `Data` does not match the documented shape for that event. */
	| 'invalid-data';

/** A message that failed to parse or validate. */
export interface ParseFailure {
	ok: false;
	reason: ParseFailureReason;
	/** The original input. */
	raw: unknown;
	/** Event name, when it could be read. */
	event?: string;
	/** Decoded payload, when it could be read. */
	data?: unknown;
}

/** A message that was decoded (and validated, unless disabled). */
export interface ParseSuccess {
	ok: true;
	event: StatsApiEvent;
}

export type ParseResult = ParseSuccess | ParseFailure;

export interface ParseOptions {
	/**
	 * Run the payload type guard for the event.
	 * When `false`, only the envelope and event name are checked and `Data` is trusted as-is.
	 * @default true
	 */
	validate?: boolean;
}

/**
 * Decodes a message coming from the Stats API socket.
 *
 * Accepts the raw JSON text, or an already `JSON.parse`d envelope. The game encodes
 * `Data` as a JSON string inside the envelope; it is decoded here. If `Data` is already
 * an object it is used directly.
 *
 * Never throws: check `result.ok`.
 */
export function parseEventMessage(raw: unknown, options: ParseOptions = {}): ParseResult {
	const validate = options.validate ?? true;

	let envelope: unknown = raw;
	if (typeof raw === 'string') {
		try {
			envelope = JSON.parse(raw);
		} catch {
			return { ok: false, reason: 'invalid-json', raw };
		}
	}

	if (!isRecord(envelope) || typeof envelope.Event !== 'string') {
		return { ok: false, reason: 'invalid-envelope', raw };
	}
	const event = envelope.Event;

	let data: unknown = envelope.Data;
	if (typeof data === 'string') {
		try {
			data = JSON.parse(data);
		} catch {
			return { ok: false, reason: 'invalid-data-json', raw, event, data };
		}
	}
	if (!isRecord(data)) {
		return { ok: false, reason: 'invalid-data-json', raw, event, data };
	}

	if (!isEventName(event)) {
		return { ok: false, reason: 'unknown-event', raw, event, data };
	}
	if (validate && !isEventData(event, data)) {
		return { ok: false, reason: 'invalid-data', raw, event, data };
	}

	return { ok: true, event: { Event: event, Data: data } as StatsApiEvent };
}
