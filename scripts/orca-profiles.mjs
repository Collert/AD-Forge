// Fetches the OrcaSlicer presets the quote server reads, as plain JSON.
//
// From 2.5, OrcaSlicer installs pack each vendor's presets into a `.opc` file,
// which the server can't read. The OrcaSlicer source keeps them as JSON, so
// this takes the vendors we use from the release tag in nixpacks.toml
// (ORCA_VERSION) with a sparse clone: a few MB, not the whole repository.
//
//   npm run orca:profiles            → .orca/profiles (used automatically in dev)
//   node scripts/orca-profiles.mjs <dir>
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Printer presets (BBL) and the filament library they fall back to. Keep in step with presets.ts. */
const VENDORS = ['BBL', 'OrcaFilamentLibrary'];
const REPO = 'https://github.com/OrcaSlicer/OrcaSlicer.git';

const version = readFileSync(new URL('../nixpacks.toml', import.meta.url), 'utf8').match(/^ORCA_VERSION\s*=\s*"([^"]+)"/m)?.[1];
if (!version) throw new Error('ORCA_VERSION not found in nixpacks.toml');

const dest = path.resolve(process.argv[2] ?? '.orca/profiles');
const clone = `${dest}.clone`;
const git = (...args) => execFileSync('git', args, { stdio: ['ignore', 'ignore', 'inherit'] });

rmSync(clone, { recursive: true, force: true, maxRetries: 5 });
console.log(`Fetching OrcaSlicer v${version} presets (${VENDORS.join(', ')})…`);
git('-c', 'advice.detachedHead=false', 'clone', '--quiet', '--depth', '1', '--branch', `v${version}`, '--filter=blob:none', '--sparse', REPO, clone);
git('-C', clone, 'sparse-checkout', 'set', '--no-cone', ...VENDORS.map((v) => `/resources/profiles/${v}/`));

const fetched = path.join(clone, 'resources', 'profiles');
for (const vendor of VENDORS) {
	if (!existsSync(path.join(fetched, vendor))) throw new Error(`OrcaSlicer v${version} has no ${vendor} presets`);
}
rmSync(dest, { recursive: true, force: true });
// Copy rather than rename: Windows often refuses to move a folder git has just written.
cpSync(fetched, dest, { recursive: true });
rmSync(clone, { recursive: true, force: true, maxRetries: 5 });
writeFileSync(path.join(dest, 'VERSION'), `${version}\n`);
console.log(`OrcaSlicer v${version} presets in ${dest}`);
