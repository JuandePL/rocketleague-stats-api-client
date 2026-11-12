import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Section of the Stats API `.ini` file that holds the exporter settings. */
export const STATS_API_SECTION = 'TAGame.MatchStatsExporter_TA';

/** `PacketSendRate` written when the Stats API is disabled. */
export const DEFAULT_PACKET_SEND_RATE = 30;

/** `.ini` file names, in lookup order. `TAStatsAPI.ini` wins over `DefaultStatsAPI.ini`. */
export const STATS_API_INI_FILES = ['TAStatsAPI.ini', 'DefaultStatsAPI.ini'] as const;

/** Epic Games Store app name of Rocket League. */
const EPIC_APP_NAME = 'Sugar';

export interface EnsureStatsApiOptions {
	/** Rocket League install directory (the folder containing `TAGame`). Auto-detected on Windows when omitted. */
	installDir?: string;
	/** Exact path of the `.ini` file to check. Overrides `installDir` and auto-detection. */
	iniPath?: string;
	/** `PacketSendRate` written when the current value is `0` or less. @default 30 */
	packetSendRate?: number;
	/**
	 * Called with a human-readable message when the file was changed (restart required) or could not be written.
	 * Pass `false` to stay silent.
	 * @default console.warn
	 */
	warn?: ((message: string) => void) | false;
}

export type EnsureStatsApiResult =
	/** No Stats API `.ini` file was found. */
	| { status: 'not-found'; searched: string[] }
	/** `PacketSendRate` was already greater than 0. */
	| { status: 'enabled'; iniPath: string; packetSendRate: number }
	/** `PacketSendRate` was `0` or less and has been set. The game must be restarted. */
	| { status: 'updated'; iniPath: string; previous: number | undefined; packetSendRate: number; restartRequired: true }
	/** The file needed a change but could not be written (e.g. no permission under `Program Files`). */
	| { status: 'write-failed'; iniPath: string; previous: number | undefined; error: unknown };

// ---------------------------------------------------------------------------
// INI editing (pure)
// ---------------------------------------------------------------------------

export interface PacketSendRateEdit {
	/** Current value, or `undefined` if the key is missing (the game then uses `0`). */
	previous: number | undefined;
	/** `true` when the Stats API is disabled (`PacketSendRate` <= 0 or missing). */
	disabled: boolean;
	/** The file contents with `PacketSendRate` set to the requested rate. Equals the input when `disabled` is false. */
	content: string;
}

const SECTION_RE = /^\s*\[([^\]]+)\]\s*$/;
const KEY_RE = /^(\s*PacketSendRate\s*=\s*)([^;\r\n]*?)(\s*(?:;.*)?)$/i;

/**
 * Reads `PacketSendRate` from the `[TAGame.MatchStatsExporter_TA]` section of an `.ini` file
 * and, if it is `0` or less (or missing), returns the contents with it set to `rate`.
 * Keeps comments, the other keys, the BOM and the line endings untouched.
 */
export function editPacketSendRate(content: string, rate = DEFAULT_PACKET_SEND_RATE): PacketSendRateEdit {
	const eol = content.includes('\r\n') ? '\r\n' : '\n';
	const lines = content.split(/\r?\n/);

	let sectionStart = -1;
	let sectionEnd = lines.length;
	for (let i = 0; i < lines.length; i++) {
		const match = SECTION_RE.exec(lines[i]!);
		if (!match) continue;
		if (sectionStart !== -1) {
			sectionEnd = i;
			break;
		}
		if (match[1]!.trim().toLowerCase() === STATS_API_SECTION.toLowerCase()) sectionStart = i;
	}

	let keyLine = -1;
	let previous: number | undefined;
	if (sectionStart !== -1) {
		for (let i = sectionStart + 1; i < sectionEnd; i++) {
			const match = KEY_RE.exec(lines[i]!);
			if (match) {
				keyLine = i;
				const value = Number.parseFloat(match[2]!);
				previous = Number.isNaN(value) ? undefined : value;
				break;
			}
		}
	}

	const disabled = previous === undefined || previous <= 0;
	if (!disabled) return { previous, disabled, content };

	if (keyLine !== -1) {
		lines[keyLine] = lines[keyLine]!.replace(KEY_RE, (_, prefix: string, _value: string, suffix: string) => `${prefix}${rate}${suffix}`);
	} else if (sectionStart !== -1) {
		lines.splice(sectionStart + 1, 0, `PacketSendRate=${rate}`);
	} else {
		// Append the section, keeping a trailing newline if the file had one.
		const hasTrailingNewline = lines.length > 0 && lines.at(-1) === '';
		if (hasTrailingNewline) lines.pop();
		if (lines.length > 0 && lines.at(-1)!.trim() !== '') lines.push('');
		lines.push(`[${STATS_API_SECTION}]`, `PacketSendRate=${rate}`);
		if (hasTrailingNewline) lines.push('');
	}
	return { previous, disabled, content: lines.join(eol) };
}

// ---------------------------------------------------------------------------
// Install directory discovery
// ---------------------------------------------------------------------------

async function exists(file: string): Promise<boolean> {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}

async function readJson(file: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(file, 'utf8'));
	} catch {
		return undefined;
	}
}

function epicInstallLocation(value: unknown): string | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	const { AppName, InstallLocation } = value as Record<string, unknown>;
	return AppName === EPIC_APP_NAME && typeof InstallLocation === 'string' ? InstallLocation : undefined;
}

/** Install directories registered by the Epic Games Launcher. */
async function findEpicInstalls(programData: string): Promise<string[]> {
	const found: string[] = [];

	const launcherInstalled = await readJson(path.join(programData, 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat'));
	const list = (launcherInstalled as { InstallationList?: unknown } | undefined)?.InstallationList;
	if (Array.isArray(list)) {
		for (const item of list) {
			const location = epicInstallLocation(item);
			if (location) found.push(location);
		}
	}

	const manifestsDir = path.join(programData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
	try {
		for (const file of await readdir(manifestsDir)) {
			if (!file.toLowerCase().endsWith('.item')) continue;
			const location = epicInstallLocation(await readJson(path.join(manifestsDir, file)));
			if (location) found.push(location);
		}
	} catch {
		// No Epic launcher.
	}
	return found;
}

/** Install directories in every Steam library. */
async function findSteamInstalls(steamDir: string): Promise<string[]> {
	const libraries = [steamDir];
	try {
		const vdf = await readFile(path.join(steamDir, 'steamapps', 'libraryfolders.vdf'), 'utf8');
		for (const match of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libraries.push(match[1]!.replace(/\\\\/g, '\\'));
	} catch {
		// No Steam, or no extra libraries.
	}
	return libraries.map((library) => path.join(library, 'steamapps', 'common', 'rocketleague'));
}

/**
 * Candidate Rocket League install directories (Epic Games Store and Steam, Windows only).
 * Not every returned directory necessarily exists.
 */
export async function findRocketLeagueInstallDirs(): Promise<string[]> {
	if (process.platform !== 'win32') return [];
	const env = process.env;
	const programData = env.ProgramData ?? 'C:\\ProgramData';
	const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
	const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';

	const candidates = [
		...(await findEpicInstalls(programData)),
		path.join(programFiles, 'Epic Games', 'rocketleague'),
		...(await findSteamInstalls(path.join(programFilesX86, 'Steam'))),
	];
	return [...new Set(candidates.map((dir) => path.normalize(dir)))];
}

/** Paths of the Stats API `.ini` files inside an install directory, in lookup order. */
export function statsApiIniPaths(installDir: string): string[] {
	return STATS_API_INI_FILES.map((file) => path.join(installDir, 'TAGame', 'Config', file));
}

/** Returns the Stats API `.ini` file in use (`TAStatsAPI.ini`, else `DefaultStatsAPI.ini`), or `undefined`. */
export async function findStatsApiIni(installDir?: string): Promise<{ iniPath: string | undefined; searched: string[] }> {
	const dirs = installDir ? [installDir] : await findRocketLeagueInstallDirs();
	const searched: string[] = [];
	for (const dir of dirs) {
		for (const file of statsApiIniPaths(dir)) {
			searched.push(file);
			if (await exists(file)) return { iniPath: file, searched };
		}
	}
	return { iniPath: undefined, searched };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Looks for the Stats API `.ini` file (`TAStatsAPI.ini` or `DefaultStatsAPI.ini`). If `PacketSendRate`
 * is `0` or less, sets it to `30` (or `options.packetSendRate`) and warns that the game must be restarted,
 * since Rocket League only reads this file at launch.
 *
 * Never throws: every outcome is reported in the returned result.
 */
export async function ensureStatsApiEnabled(options: EnsureStatsApiOptions = {}): Promise<EnsureStatsApiResult> {
	const rate = options.packetSendRate ?? DEFAULT_PACKET_SEND_RATE;
	if (!Number.isFinite(rate) || rate <= 0) throw new RangeError(`packetSendRate must be greater than 0, got ${rate}.`);
	const warn = options.warn === false ? () => {} : (options.warn ?? ((message: string) => console.warn(message)));

	let iniPath = options.iniPath;
	let searched = iniPath ? [iniPath] : [];
	if (iniPath === undefined) {
		({ iniPath, searched } = await findStatsApiIni(options.installDir));
	}

	let content: string;
	let encoding: BufferEncoding;
	try {
		if (!iniPath) throw new Error('not found');
		const buffer = await readFile(iniPath);
		// Unreal may save .ini files as UTF-16LE (with BOM). Keep whatever encoding the file uses.
		encoding = buffer[0] === 0xff && buffer[1] === 0xfe ? 'utf16le' : 'utf8';
		content = buffer.toString(encoding);
	} catch {
		return { status: 'not-found', searched };
	}

	const edit = editPacketSendRate(content, rate);
	if (!edit.disabled) return { status: 'enabled', iniPath, packetSendRate: edit.previous! };

	try {
		await writeFile(iniPath, edit.content, encoding);
	} catch (error) {
		warn(
			`[rocketleague-stats-api-client] The Rocket League Stats API is disabled (PacketSendRate=${edit.previous ?? 0}) ` +
				`but "${iniPath}" could not be written. Set PacketSendRate=${rate} manually (you may need administrator rights) ` +
				'and restart the game.',
		);
		return { status: 'write-failed', iniPath, previous: edit.previous, error };
	}

	warn(
		`[rocketleague-stats-api-client] The Rocket League Stats API was disabled (PacketSendRate=${edit.previous ?? 0}). ` +
			`PacketSendRate has been set to ${rate} in "${iniPath}". Restart Rocket League for the Stats API to work.`,
	);
	return { status: 'updated', iniPath, previous: edit.previous, packetSendRate: rate, restartRequired: true };
}
