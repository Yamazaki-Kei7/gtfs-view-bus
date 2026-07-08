import { describe, expect, it } from 'vitest';
import { centroidOf, cumulativeDistances, haversineMeters } from './geo';

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

	it('空配列は空配列を返す(coords と同じ長さの契約)', () => {
		expect(cumulativeDistances([])).toEqual([]);
	});
});

describe('centroidOf', () => {
	it('空配列は null', () => {
		expect(centroidOf([])).toBeNull();
	});

	it('外れ値に引きずられない成分別中央値を返す', () => {
		const pts: [number, number][] = [
			[139.7, 35.68],
			[139.71, 35.69],
			[139.69, 35.67],
			[999, 999],
		];
		const c = centroidOf(pts);
		expect(c).not.toBeNull();
		expect(c![0]).toBeGreaterThan(139.6);
		expect(c![0]).toBeLessThan(139.8);
		expect(c![1]).toBeGreaterThan(35.6);
		expect(c![1]).toBeLessThan(35.8);
	});
});
