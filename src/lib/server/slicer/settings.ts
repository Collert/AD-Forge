/**
 * The configurator's FDM settings as OrcaSlicer print options. They're written
 * on the object (not the project), so they travel with the part when its 3MF
 * is imported into another project in OrcaSlicer or Bambu Studio.
 */
import {
	compensationRange,
	fuzzySkinModes,
	infillPatterns,
	infillRange,
	nozzles,
	overhangRange,
	qualities,
	shellCountRange,
	supportPlacements,
	wallLoopOptions,
	wallSequences,
	type NumberRange
} from '$lib/catalog/config';
import type { PrintSettings } from '$lib/pricing/estimate';

/** Settings from a request, checked against what the configurator offers. Throws a customer-facing message. */
export function parsePrintSettings(input: unknown, soluble: boolean): PrintSettings {
	const s = (input ?? {}) as Record<string, unknown>;
	const pick = <T extends string>(key: string, allowed: readonly T[]) => {
		const v = s[key];
		if (!allowed.includes(v as T)) throw new Error(`Invalid ${key}.`);
		return v as T;
	};
	const oneOf = (key: string, allowed: number[]) => {
		const v = s[key];
		if (typeof v !== 'number' || !allowed.includes(v)) throw new Error(`Invalid ${key}.`);
		return v;
	};
	const number = (key: string, range: NumberRange) => {
		const v = Number(s[key]);
		if (!Number.isFinite(v) || v < range.min || v > range.max) throw new Error(`Invalid ${key}.`);
		return v;
	};
	const bool = (key: string) => {
		if (typeof s[key] !== 'boolean') throw new Error(`Invalid ${key}.`);
		return s[key] as boolean;
	};
	const ids = (list: { id: string }[]) => list.map((o) => o.id);

	return {
		layerHeight: oneOf('layerHeight', qualities.map((q) => q.layerHeight)),
		nozzle: oneOf('nozzle', nozzles.map((n) => n.size)),
		wallLoops: oneOf('wallLoops', wallLoopOptions),
		topShells: Math.round(number('topShells', shellCountRange)),
		bottomShells: Math.round(number('bottomShells', shellCountRange)),
		wallSequence: pick('wallSequence', ids(wallSequences)),
		detectThinWalls: bool('detectThinWalls'),
		infill: Math.round(number('infill', infillRange)),
		infillPattern: pick('infillPattern', ids(infillPatterns)),
		supportPlacement: pick('supportPlacement', ids(supportPlacements)),
		overhangAngle: Math.round(number('overhangAngle', overhangRange)),
		supportInterface: pick('supportInterface', soluble ? ['same', 'soluble'] : ['same']),
		xyHoleCompensation: number('xyHoleCompensation', compensationRange),
		xyContourCompensation: number('xyContourCompensation', compensationRange),
		ironing: bool('ironing'),
		fuzzySkin: pick('fuzzySkin', ids(fuzzySkinModes))
	};
}

const WALL_SEQUENCE: Record<string, string> = { 'inner-outer': 'inner wall/outer wall', 'outer-inner': 'outer wall/inner wall' };
const FUZZY_SKIN: Record<string, string> = { none: 'none', outer: 'external', all: 'allwalls' };

/** Orca option keys and values for every setting, to store on the object. Nozzle is a printer setting, so it's not here. */
export function objectSettings(s: PrintSettings): Record<string, string> {
	const supports = s.supportPlacement !== 'none';
	const settings: Record<string, string> = {
		layer_height: String(s.layerHeight),
		wall_loops: String(s.wallLoops),
		top_shell_layers: String(s.topShells),
		bottom_shell_layers: String(s.bottomShells),
		wall_sequence: WALL_SEQUENCE[s.wallSequence],
		detect_thin_wall: flag(s.detectThinWalls),
		sparse_infill_density: `${s.infill}%`,
		sparse_infill_pattern: s.infillPattern,
		enable_support: flag(supports),
		support_type: 'tree(auto)',
		support_on_build_plate_only: flag(s.supportPlacement === 'build-plate'),
		// The configurator measures the overhang from vertical, Orca from the bed.
		support_threshold_angle: String(90 - s.overhangAngle),
		xy_hole_compensation: String(s.xyHoleCompensation),
		xy_contour_compensation: String(s.xyContourCompensation),
		ironing_type: s.ironing ? 'top' : 'no ironing',
		fuzzy_skin: FUZZY_SKIN[s.fuzzySkin]
	};
	if (supports && s.supportInterface === 'soluble') {
		// Filament 2 is the soluble one: interface layers touch the part, so no gap is needed.
		Object.assign(settings, {
			support_interface_filament: '2',
			support_top_z_distance: '0',
			support_bottom_z_distance: '0',
			support_interface_spacing: '0'
		});
	}
	return settings;
}

const flag = (on: boolean) => (on ? '1' : '0');
