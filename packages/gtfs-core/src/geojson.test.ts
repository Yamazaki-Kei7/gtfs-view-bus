import { describe, expect, it } from 'vitest';
import { convertFeed } from './convert';
import { FIXTURE_FILES } from './fixture';
import { shapesToGeojson, stopsToGeojson } from './geojson';

describe('stopsToGeojson', () => {
	it('stops.txt をPointのFeatureCollectionへ変換する', () => {
		const fc = stopsToGeojson(FIXTURE_FILES);
		expect(fc.type).toBe('FeatureCollection');
		expect(fc.features).toHaveLength(3);
		expect(fc.features[0]).toEqual({
			type: 'Feature',
			geometry: { type: 'Point', coordinates: [139, 36] },
			properties: { stop_id: 'A', stop_name: '駅前' },
		});
	});

	it('座標が数値でない行と空欄の行はスキップする', () => {
		const files = {
			'stops.txt':
				'stop_id,stop_name,stop_lat,stop_lon\nX,壊れ,abc,139.0\nY,空欄,,139.0\nZ,正常,36.0,139.0\n',
		};
		const fc = stopsToGeojson(files);
		expect(fc.features).toHaveLength(1);
		expect(fc.features[0].properties.stop_id).toBe('Z');
	});

	it('stops.txt が無ければ空のFeatureCollectionを返す', () => {
		expect(stopsToGeojson({}).features).toHaveLength(0);
	});
});

describe('shapesToGeojson', () => {
	it('bundleのshapesをLineStringのFeatureCollectionへ変換する', () => {
		const bundle = convertFeed(FIXTURE_FILES);
		const fc = shapesToGeojson(bundle);
		expect(fc.type).toBe('FeatureCollection');
		expect(fc.features.length).toBeGreaterThan(0);
		for (const f of fc.features) {
			expect(f.geometry.type).toBe('LineString');
			expect(f.geometry.coordinates.length).toBeGreaterThanOrEqual(2);
		}
	});
});
