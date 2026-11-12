/**
 * Node.js entry point: everything from the main entry, plus helpers that read and fix the
 * Stats API `.ini` file. The client exported here checks the file automatically.
 */
import { RocketLeagueStatsClient as BaseClient, type StatsApiClientOptions } from './client.js';
import { ensureStatsApiEnabled, type EnsureStatsApiOptions, type EnsureStatsApiResult } from './node/config.js';

export * from './index.js';
export * from './node/config.js';

export interface NodeStatsApiClientOptions extends StatsApiClientOptions {
	/**
	 * Check the Stats API `.ini` file on construction and, if `PacketSendRate` is `0` or less,
	 * set it to `30` and warn that the game must be restarted. `false` disables the check.
	 * @default true
	 */
	ensureStatsApi?: boolean | EnsureStatsApiOptions;
}

/**
 * {@link BaseClient} that also makes sure the Stats API is enabled in the game's `.ini` file.
 * The result of that check is available on {@link statsApiConfig}.
 */
export class RocketLeagueStatsClient extends BaseClient {
	/** Result of the `.ini` check, or `undefined` when `ensureStatsApi: false`. Never rejects. */
	readonly statsApiConfig: Promise<EnsureStatsApiResult> | undefined;

	constructor(options: NodeStatsApiClientOptions = {}) {
		const { ensureStatsApi = true, ...clientOptions } = options;
		const ensureOptions = ensureStatsApi === true ? {} : ensureStatsApi;
		const rate = ensureOptions === false ? undefined : ensureOptions.packetSendRate;
		if (rate !== undefined && !(Number.isFinite(rate) && rate > 0)) {
			throw new RangeError(`packetSendRate must be greater than 0, got ${rate}.`);
		}
		super(clientOptions);
		this.statsApiConfig = ensureOptions === false ? undefined : ensureStatsApiEnabled(ensureOptions);
	}
}

export default RocketLeagueStatsClient;
