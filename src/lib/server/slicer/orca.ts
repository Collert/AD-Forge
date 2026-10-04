/**
 * Runs the OrcaSlicer command line. One install serves every quote; runs are
 * queued so a burst of quotes can't start more slicers than the machine has
 * room for.
 *
 * ORCA_SLICER_PATH: the executable (default: the Windows install path, else
 * `orca-slicer` on PATH). ORCA_PROFILES_DIR: its bundled system presets
 * (default: resources/profiles next to the executable).
 */
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { env } from '$env/dynamic/private';

const WINDOWS_EXE = 'C:\\Program Files\\OrcaSlicer\\orca-slicer.exe';
const TIMEOUT_MS = 5 * 60_000;
/** Each run is multi-threaded, so only a couple at a time. */
const MAX_RUNS = Math.max(1, Math.min(2, Math.floor(availableParallelism() / 4)));

export function orcaExe() {
	return env.ORCA_SLICER_PATH || (process.platform === 'win32' ? WINDOWS_EXE : 'orca-slicer');
}

export function orcaProfilesDir() {
	return env.ORCA_PROFILES_DIR || path.join(path.dirname(orcaExe()), 'resources', 'profiles');
}

/** A slicer failure; `message` is safe to show the customer. */
export class SlicerError extends Error {
	constructor(
		message: string,
		/** 400: the model or settings can't be printed as asked. 500/503: our side. */
		readonly status: 400 | 500 | 503 = 500,
		readonly detail?: string
	) {
		super(message);
	}
}

/** Orca's CLI exit codes (src/OrcaSlicer.hpp) worth a specific message. */
const EXIT_MESSAGES: Record<number, [number, string]> = {
	[-3]: [500, 'The slicer could not read the model.'],
	[-5]: [500, 'The slicer could not load its print profiles.'],
	[-6]: [400, 'The model file could not be read. Try re-exporting it from your CAD tool.'],
	[-17]: [500, 'The selected print profile does not fit this printer.'],
	[-18]: [400, 'Some print settings are out of range for this printer.'],
	[-24]: [500, 'The slicer is older than the project format.'],
	[-50]: [400, "The part doesn't fit the build plate."],
	[-100]: [400, "The slicer couldn't slice this model. It may be broken or have no printable layers; try auto-repair or re-export it."]
};

let running = 0;
const waiting: (() => void)[] = [];

async function slot<T>(work: () => Promise<T>): Promise<T> {
	if (running >= MAX_RUNS) await new Promise<void>((resolve) => waiting.push(resolve));
	running++;
	try {
		return await work();
	} finally {
		running--;
		waiting.shift()?.();
	}
}

/** Run the CLI with `args` and resolve once it exits 0; any other exit throws a SlicerError. */
export function runOrca(args: string[]): Promise<void> {
	return slot(
		() =>
			new Promise<void>((resolve, reject) => {
				const child = spawn(orcaExe(), args, { windowsHide: true });
				let output = '';
				const collect = (chunk: Buffer) => {
					output = (output + chunk.toString()).slice(-8000);
				};
				child.stdout.on('data', collect);
				child.stderr.on('data', collect);

				const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
				child.on('error', (err) => {
					clearTimeout(timer);
					const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
					reject(new SlicerError('Accurate quotes are unavailable right now.', 503, missing ? `OrcaSlicer not found at ${orcaExe()}` : err.message));
				});
				child.on('close', (code, signal) => {
					clearTimeout(timer);
					if (code === 0) return resolve();
					// Windows reports the negative codes as unsigned 32-bit.
					const exit = code === null ? null : code | 0;
					const [status, message] = (exit !== null && EXIT_MESSAGES[exit]) || [500, 'The slicer failed on this model.'];
					const why = signal ? `killed (${signal}) after ${TIMEOUT_MS / 1000}s` : `exit ${exit}`;
					reject(new SlicerError(message, status as 400 | 500, `orca-slicer ${why}: ${output.trim()}`));
				});
			})
	);
}
