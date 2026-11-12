import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editPacketSendRate, ensureStatsApiEnabled, RocketLeagueStatsClient } from '../src/node.js';
import { RocketLeagueStatsClient as MainClient } from '../src/index.js';

describe('editPacketSendRate', () => {
	it('replaces 0 and keeps the rest of the file, comments and CRLF', () => {
		const ini = '[Other]\r\nPacketSendRate=0\r\n[TAGame.MatchStatsExporter_TA]\r\nPacketSendRate=0 ; disabled\r\nWebPort=49124\r\n';
		const edit = editPacketSendRate(ini);
		expect(edit).toMatchObject({ previous: 0, disabled: true });
		expect(edit.content).toBe(
			'[Other]\r\nPacketSendRate=0\r\n[TAGame.MatchStatsExporter_TA]\r\nPacketSendRate=30 ; disabled\r\nWebPort=49124\r\n',
		);
	});

	it('replaces negative values', () => {
		const edit = editPacketSendRate('[TAGame.MatchStatsExporter_TA]\nPacketSendRate = -5\n');
		expect(edit).toMatchObject({ previous: -5, disabled: true });
		expect(edit.content).toBe('[TAGame.MatchStatsExporter_TA]\nPacketSendRate = 30\n');
	});

	it('leaves enabled files untouched', () => {
		const ini = '[TAGame.MatchStatsExporter_TA]\nPacketSendRate=60\n';
		expect(editPacketSendRate(ini)).toEqual({ previous: 60, disabled: false, content: ini });
	});

	it('adds the key when missing from the section', () => {
		const edit = editPacketSendRate('[TAGame.MatchStatsExporter_TA]\nWebPort=49124\n');
		expect(edit).toMatchObject({ previous: undefined, disabled: true });
		expect(edit.content).toBe('[TAGame.MatchStatsExporter_TA]\nPacketSendRate=30\nWebPort=49124\n');
	});

	it('adds the section when missing', () => {
		const edit = editPacketSendRate('[Other]\nFoo=1\n', 60);
		expect(edit.content).toBe('[Other]\nFoo=1\n\n[TAGame.MatchStatsExporter_TA]\nPacketSendRate=60\n');
	});
});

describe('ensureStatsApiEnabled', () => {
	let installDir: string;
	let configDir: string;

	beforeEach(async () => {
		installDir = await mkdtemp(path.join(tmpdir(), 'rl-stats-'));
		configDir = path.join(installDir, 'TAGame', 'Config');
		await mkdir(configDir, { recursive: true });
	});
	afterEach(() => rm(installDir, { recursive: true, force: true }));

	it('sets PacketSendRate to 30 and warns that a restart is needed', async () => {
		const file = path.join(configDir, 'DefaultStatsAPI.ini');
		await writeFile(file, '[TAGame.MatchStatsExporter_TA]\nPacketSendRate=0\n');
		const warn = vi.fn();

		const result = await ensureStatsApiEnabled({ installDir, warn });

		expect(result).toEqual({ status: 'updated', iniPath: file, previous: 0, packetSendRate: 30, restartRequired: true });
		expect(await readFile(file, 'utf8')).toBe('[TAGame.MatchStatsExporter_TA]\nPacketSendRate=30\n');
		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0]![0]).toMatch(/Restart Rocket League/);
	});

	it('prefers TAStatsAPI.ini over DefaultStatsAPI.ini', async () => {
		await writeFile(path.join(configDir, 'DefaultStatsAPI.ini'), '[TAGame.MatchStatsExporter_TA]\nPacketSendRate=0\n');
		await writeFile(path.join(configDir, 'TAStatsAPI.ini'), '[TAGame.MatchStatsExporter_TA]\nPacketSendRate=120\n');
		const warn = vi.fn();

		const result = await ensureStatsApiEnabled({ installDir, warn });

		expect(result).toEqual({ status: 'enabled', iniPath: path.join(configDir, 'TAStatsAPI.ini'), packetSendRate: 120 });
		expect(warn).not.toHaveBeenCalled();
	});

	it('keeps UTF-16LE files in UTF-16LE', async () => {
		const file = path.join(configDir, 'TAStatsAPI.ini');
		await writeFile(file, Buffer.from('﻿[TAGame.MatchStatsExporter_TA]\r\nPacketSendRate=0\r\n', 'utf16le'));

		await ensureStatsApiEnabled({ installDir, warn: false });

		const buffer = await readFile(file);
		expect([buffer[0], buffer[1]]).toEqual([0xff, 0xfe]);
		expect(buffer.toString('utf16le')).toBe('﻿[TAGame.MatchStatsExporter_TA]\r\nPacketSendRate=30\r\n');
	});

	it('reports not-found without touching anything', async () => {
		const result = await ensureStatsApiEnabled({ installDir, warn: false });
		expect(result.status).toBe('not-found');
	});

	it('runs from the Node client constructor', async () => {
		const file = path.join(configDir, 'TAStatsAPI.ini');
		await writeFile(file, '[TAGame.MatchStatsExporter_TA]\nPacketSendRate=0\n');

		const client = new RocketLeagueStatsClient({ autoConnect: false, ensureStatsApi: { installDir, warn: false } });

		await expect(client.statsApiConfig).resolves.toMatchObject({ status: 'updated', restartRequired: true });
		expect(() => new RocketLeagueStatsClient({ autoConnect: false, ensureStatsApi: { packetSendRate: 0 } })).toThrow(RangeError);
	});

	it('is the same client in the main entry, and can be disabled', async () => {
		const file = path.join(configDir, 'TAStatsAPI.ini');
		await writeFile(file, '[TAGame.MatchStatsExporter_TA]\nPacketSendRate=0\n');

		expect(MainClient).toBe(RocketLeagueStatsClient);
		expect(new MainClient({ autoConnect: false, ensureStatsApi: false }).statsApiConfig).toBeUndefined();
		await expect(
			new MainClient({ autoConnect: false, ensureStatsApi: { installDir, warn: false } }).statsApiConfig,
		).resolves.toMatchObject({ status: 'updated' });
	});
});
