import { describe, expect, it } from 'vitest';
import { convertFeed } from './convert';
import { FIXTURE_FILES } from './fixture';
import { shapesToGeojson, stopRouteIds, stopsToGeojson } from './geojson';

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

describe('stopRouteIds', () => {
	it('各停留所を通る route_id 集合を stop_times × trips から算出する', () => {
		// フィクスチャ: A/B/C とも T1・T2(R1)と T3(R2)が通る
		expect(stopRouteIds(FIXTURE_FILES)).toEqual({
			A: ['R1', 'R2'],
			B: ['R1', 'R2'],
			C: ['R1', 'R2'],
		});
	});

	it('stop_times が無ければ空オブジェクトを返す', () => {
		expect(stopRouteIds({})).toEqual({});
	});

	it('trips に無い trip_id の stop_time は無視する', () => {
		const files = {
			'trips.txt': 'route_id,service_id,trip_id\nRX,WD,T9\n',
			'stop_times.txt':
				'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT9,08:00,08:00,S1,1\nGHOST,09:00,09:00,S2,1\n',
		};
		expect(stopRouteIds(files)).toEqual({ S1: ['RX'] });
	});
});
