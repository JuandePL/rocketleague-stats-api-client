import type { AnyEventListener, Unsubscribe } from './client.js';
import type { StatsEventSource } from './stats/match.js';
import type { StatsApiEvent } from './types/events.js';

/**
 * An event source that outlives the clients: give it to an `EsportsSeries` or a `MatchTracker` once, and forward
 * the events of each client to it. So the stats and the series survive reconnecting with a new client.
 *
 * ```ts
 * const relay = new EventRelay();
 * const series = new EsportsSeries(relay);
 * const stop = relay.forward(client); // later: stop(); relay.forward(otherClient);
 * ```
 */
export class EventRelay implements StatsEventSource {
	readonly #listeners = new Set<AnyEventListener>();

	onAny(listener: AnyEventListener): Unsubscribe {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** Sends one event to every listener. */
	emit(event: StatsApiEvent): void {
		for (const listener of [...this.#listeners]) listener(event);
	}

	/** Forwards every event of `source` until the returned function is called. */
	forward(source: StatsEventSource): Unsubscribe {
		return source.onAny((event) => this.emit(event));
	}
}
