import { describe, expect, it } from 'vitest';
import { PREFECTURES_GEOJSON, resolvePrefId } from './prefectureGeometry';

describe('PREFECTURES_GEOJSON', () => {
	it('47 features で properties.id を持つ', () => {
		expect(PREFECTURES_GEOJSON.features).toHaveLength(47);
		for (const f of PREFECTURES_GEOJSON.features) {
			expect(typeof f.properties.id).toBe('number');
		}
	});
});

describe('resolvePrefId', () => {
	it.each([
		['札幌', 141.3469, 43.0642, 1],
		['前橋', 139.0608, 36.3912, 10],
		['東京駅', 139.7671, 35.6812, 13],
		['大阪', 135.5023, 34.6937, 27],
		['那覇', 127.6809, 26.2124, 47],
	])('%s は id %d', (_name, lng, lat, expected) => {
		expect(resolvePrefId(lng, lat)).toBe(expected);
	});

	it('陸から遠い海上は null', () => {
		expect(resolvePrefId(150, 30)).toBeNull();
	});
});
