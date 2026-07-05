import { describe, expect, it } from 'vitest';
import { busFeatureCollection } from './bus';
import { convertFeed } from './convert';
import { FIXTURE_FILES } from './fixture';

const feeds = [{ id: 'test~feed~20260401', bundle: convertFeed(FIXTURE_FILES) }];

describe('busFeatureCollection', () => {
	it('運行中の時刻はバスが1台表示される(平日 2026-07-06 08:05)', () => {
		const fc = busFeatureCollection(feeds, '20260706', 8 * 3600 + 5 * 60);
		expect(fc.features.length).toBe(1);
		const f = fc.features[0];
		expect(f.properties.tripId).toBe('T1');
		expect(f.properties.routeName).toBe('1');
		// A(139.0)→C(139.01) の途中
		expect(f.geometry.coordinates[0]).toBeGreaterThan(139.0);
		expect(f.geometry.coordinates[0]).toBeLessThan(139.01);
	});

	it('運行時間外は0台', () => {
		expect(busFeatureCollection(feeds, '20260706', 12 * 3600).features.length).toBe(0);
	});

	it('運休日(土曜)は0台', () => {
		expect(busFeatureCollection(feeds, '20260711', 8 * 3600 + 5 * 60).features.length).toBe(0);
	});

	it('前日の24時超便が深夜帯に表示される(火曜 01:05 = 月曜の25:05発 T2)', () => {
		const fc = busFeatureCollection(feeds, '20260707', 1 * 3600 + 5 * 60);
		expect(fc.features.map((f) => f.properties.tripId)).toContain('T2');
	});
});
