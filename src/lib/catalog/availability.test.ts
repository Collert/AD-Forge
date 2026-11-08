import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allowedNozzles, availability, materialReadyDate, parseNozzles, revalidateNozzle } from './availability.ts';

const ALL = [0.2, 0.4, 0.6, 0.8];
const PREFERRED = 0.4;

/** What the configurator does when the selected colour variant changes. */
const onVariantChange = (current: number, approved: string | undefined) =>
	revalidateNozzle(current, allowedNozzles(parseNozzles(approved), ALL), PREFERRED);

describe('nozzle re-validation on variant change', () => {
	it('keeps a nozzle the new variant allows', () => {
		assert.equal(onVariantChange(0.6, '["0.6","0.8"]'), 0.6);
	});

	it('PETG Basic → Translucent drops 0.2 for 0.4', () => {
		assert.equal(onVariantChange(0.2, '["0.2","0.4","0.6","0.8"]'), 0.2);
		assert.equal(onVariantChange(0.2, '["0.4","0.6","0.8"]'), 0.4);
	});

	it('TPU 95A HF → 85A moves 0.4 to 0.6', () => {
		assert.equal(onVariantChange(0.4, '["0.4","0.6","0.8"]'), 0.4);
		assert.equal(onVariantChange(0.4, '["0.6","0.8"]'), 0.6);
	});

	it('breaks ties toward the preferred size', () => {
		// 0.6 is equally far from 0.4 and 0.8; 0.4 is preferred.
		assert.equal(onVariantChange(0.6, '["0.4","0.8"]'), 0.4);
	});

	it('allows every nozzle when the variant has no (readable) list', () => {
		assert.deepEqual(allowedNozzles(parseNozzles(undefined), ALL), ALL);
		assert.deepEqual(allowedNozzles(parseNozzles('not json'), ALL), ALL);
		assert.equal(onVariantChange(0.2, undefined), 0.2);
	});
});

describe('supplier ETA availability', () => {
	// 2026-11-08 10:00 in Vancouver (PST, UTC-8).
	const now = new Date('2026-11-08T18:00:00Z');

	it('is in stock when stock covers the job (or inventory is untracked)', () => {
		assert.deepEqual(availability({ available: 500, supplierEta: '2026-11-20' }, 120, now), { inStock: true });
		assert.deepEqual(availability({ available: 120 }, 120, now), { inStock: true });
		assert.deepEqual(availability({ available: null }, 9999, now), { inStock: true });
	});

	it('short with no ETA ships in about 3–5 days', () => {
		const a = availability({ available: 50 }, 120, now);
		assert.equal(a.inStock, false);
		assert.ok(!a.inStock && a.message === 'Not in stock — ships in about 3–5 days');
		assert.ok(!a.inStock && !a.fromEta && a.readyDate === '2026-11-13');
	});

	it('short with an ETA arrives ETA + 3 days', () => {
		const a = availability({ available: 0, supplierEta: '2026-11-11' }, 120, now);
		assert.ok(!a.inStock && a.fromEta && a.readyDate === '2026-11-14');
		assert.ok(!a.inStock && a.message === 'Not in stock — estimated arrival Sat, Nov 14, 2026');
	});

	it('an ETA of today still counts', () => {
		const a = availability({ available: 0, supplierEta: '2026-11-08' }, 1, now);
		assert.ok(!a.inStock && a.fromEta && a.readyDate === '2026-11-11');
	});

	it('treats a past ETA as empty', () => {
		const a = availability({ available: 0, supplierEta: '2026-11-07' }, 1, now);
		assert.ok(!a.inStock && !a.fromEta && a.message === 'Not in stock — ships in about 3–5 days');
	});

	it('uses the Vancouver date, not UTC', () => {
		// 2026-11-09 02:00 UTC is still Nov 8 in Vancouver, so an ETA of Nov 8 isn't past yet.
		const lateEvening = new Date('2026-11-09T02:00:00Z');
		const a = availability({ available: 0, supplierEta: '2026-11-08' }, 1, lateEvening);
		assert.ok(!a.inStock && a.fromEta);
	});

	it('multi-material jobs are ready on the latest date', () => {
		const part = availability({ available: 0, supplierEta: '2026-11-20' }, 100, now); // ready Nov 23
		const pva = availability({ available: 0 }, 10, now); // about Nov 13
		assert.deepEqual(materialReadyDate([part, pva]), { date: '2026-11-23', fromEta: true, message: 'Materials ready: Mon, Nov 23, 2026' });

		const soon = availability({ available: 0, supplierEta: '2026-11-09' }, 100, now); // ready Nov 12
		assert.deepEqual(materialReadyDate([soon, pva]), { date: '2026-11-13', fromEta: false, message: 'Materials ready: about Fri, Nov 13, 2026' });

		assert.equal(materialReadyDate([{ inStock: true }, { inStock: true }]), null);
	});
});
