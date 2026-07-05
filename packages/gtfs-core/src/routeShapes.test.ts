import { describe, expect, it } from 'vitest';
import { matchStopsToRouteLines, parseRouteLines } from './routeShapes';
import type { LngLat } from './types';

/** 東西1113m(赤道上0.01度)の道路を0.001度刻みで表した密なポリライン */
const road: LngLat[] = Array.from({ length: 11 }, (_, i) => [i * 0.001, 0]);

describe('parseRouteLines', () => {
	it('LineString と MultiLineString を route_id ごとのパーツ配列にする', () => {
		const text = JSON.stringify({
			type: 'FeatureCollection',
			features: [
				{
					type: 'Feature',
					properties: { id: '10', route_name: 'A線' },
					geometry: {
						type: 'LineString',
						coordinates: [
							[0, 0],
							[1, 1],
						],
					},
				},
				{
					type: 'Feature',
					properties: { id: 20 },
					geometry: {
						type: 'MultiLineString',
						coordinates: [
							[
								[0, 0],
								[1, 0],
							],
							[
								[1, 0],
								[2, 0],
							],
						],
					},
				},
			],
		});
		const lines = parseRouteLines(text);
		expect(lines['10'].length).toBe(1);
		expect(lines['20'].length).toBe(2);
	});

	it('id なし・不正ジオメトリはスキップする', () => {
		const text = JSON.stringify({
			type: 'FeatureCollection',
			features: [
				{
					type: 'Feature',
					properties: {},
					geometry: {
						type: 'LineString',
						coordinates: [
							[0, 0],
							[1, 1],
						],
					},
				},
				{ type: 'Feature', properties: { id: '30' }, geometry: null },
			],
		});
		expect(Object.keys(parseRouteLines(text))).toEqual([]);
	});
});

describe('matchStopsToRouteLines', () => {
	it('道路沿いの停留所列は小さな誤差でマッチし距離が単調増加する', () => {
		// 道路から約11m(0.0001度)ずれた停留所
		const stops: LngLat[] = [
			[0.001, 0.0001],
			[0.005, -0.0001],
			[0.009, 0.0001],
		];
		const m = matchStopsToRouteLines([road], stops);
		expect(m).not.toBeNull();
		expect(m!.maxError).toBeLessThan(30);
		expect(m!.distances[0]).toBeLessThan(m!.distances[1]);
		expect(m!.distances[1]).toBeLessThan(m!.distances[2]);
	});

	it('逆順の停留所列(復路便)は逆向き候補にマッチする', () => {
		const stops: LngLat[] = [
			[0.009, 0.0001],
			[0.005, -0.0001],
			[0.001, 0.0001],
		];
		const m = matchStopsToRouteLines([road], stops);
		expect(m).not.toBeNull();
		expect(m!.maxError).toBeLessThan(30);
		// 逆向き候補上で距離は単調増加になる
		expect(m!.distances[0]).toBeLessThan(m!.distances[2]);
	});

	it('路線から大きく外れた停留所列は誤差が大きい(呼び出し側で棄却される)', () => {
		const stops: LngLat[] = [
			[0.001, 0.05], // 約5.5km 北
			[0.009, 0.05],
		];
		const m = matchStopsToRouteLines([road], stops);
		expect(m).not.toBeNull();
		expect(m!.maxError).toBeGreaterThan(1000);
	});

	it('パーツが分割されていても連結候補でマッチする', () => {
		const parts: LngLat[][] = [road.slice(0, 6), road.slice(5)];
		const stops: LngLat[] = [
			[0.001, 0.0001],
			[0.009, 0.0001],
		];
		const m = matchStopsToRouteLines(parts, stops);
		expect(m).not.toBeNull();
		expect(m!.maxError).toBeLessThan(30);
		expect(m!.distances[1]).toBeGreaterThan(m!.distances[0]);
	});
});
