import { describe, expect, it } from 'vitest';
import { cumulativeDistances, haversineMeters } from './geo';

describe('haversineMeters', () => {
	it('経度0.01度(緯度36度)は約900mになる', () => {
		const d = haversineMeters([139.0, 36.0], [139.01, 36.0]);
		expect(d).toBeGreaterThan(880);
		expect(d).toBeLessThan(920);
	});

	it('同一点は0', () => {
		expect(haversineMeters([139.0, 36.0], [139.0, 36.0])).toBe(0);
	});
});

describe('cumulativeDistances', () => {
	it('累積距離の配列を返す(先頭は0、単調非減少)', () => {
		const cum = cumulativeDistances([
			[139.0, 36.0],
			[139.01, 36.0],
			[139.01, 36.01],
		]);
		expect(cum.length).toBe(3);
		expect(cum[0]).toBe(0);
		expect(cum[1]).toBeCloseTo(haversineMeters([139.0, 36.0], [139.01, 36.0]), 6);
		expect(cum[2]).toBeGreaterThan(cum[1]);
	});
});
