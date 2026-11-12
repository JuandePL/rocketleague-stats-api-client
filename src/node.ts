/**
 * Node.js entry point: everything from the main entry, plus the helpers that find and edit the
 * Stats API `.ini` file. The client itself (in both entries) already runs the check automatically.
 */
export * from './index.js';
export * from './node/config.js';

export { RocketLeagueStatsClient as default } from './client.js';
