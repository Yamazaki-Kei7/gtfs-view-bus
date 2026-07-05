import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { convertFeed, unzipFeed } from './convert';
import { FIXTURE_FILES, FIXTURE_ROUTES_GEOJSON } from './fixture';

describe('convertFeed', () => {
	const bundle = convertFeed(FIXTURE_FILES, FIXTURE_ROUTES_GEOJSON);

	it('routes を変換する', () => {
		expect(bundle.routes.R1).toEqual({ shortName: '1', longName: '駅前線', color: '#FF0000' });
	});

	it('shape_id ありの trip はそのshapeでキーフレーム化される', () => {
		const t1 = bundle.trips.find((t) => t.tripId === 'T1');
		expect(t1).toBeDefined();
		expect(t1?.shapeId).toBe('S1');
		// 08:00発 A(0m) → 08:10/08:11 B(停車で2点) → 08:30 C(終点)
		expect(t1?.keyframes.length).toBe(4);
		expect(t1?.keyframes[0][0]).toBe(8 * 3600);
		expect(t1?.keyframes[0][1]).toBeCloseTo(0, 0);
		const total = bundle.shapes.S1.cumDist.at(-1) ?? 0;
		expect(t1?.keyframes[3][1]).toBeCloseTo(total, 0);
	});

	it('shape も routes.geojson も無い trip は停留所座標の直線ポリラインになる', () => {
		// T2 の route R1 は FIXTURE_ROUTES_GEOJSON に存在しない
		const t2 = bundle.trips.find((t) => t.tripId === 'T2');
		expect(t2?.shapeId).toBe('trip:T2');
		expect(bundle.shapes['trip:T2'].coords.length).toBe(3);
	});

	it('shapes.txt が無い trip は routes.geojson の道路形状にマッチされる', () => {
		const t3 = bundle.trips.find((t) => t.tripId === 'T3');
		expect(t3?.shapeId.startsWith('route:R2:')).toBe(true);
		const shape = bundle.shapes[t3?.shapeId ?? ''];
		expect(shape.coords.length).toBeGreaterThan(10); // 停留所数(3)より密な道路頂点
		// キーフレーム距離は単調増加
		const dists = (t3?.keyframes ?? []).map((k) => k[1]);
		expect(dists[0]).toBeLessThan(dists[dists.length - 1]);
	});

	it('形状ソースの内訳が記録される', () => {
		expect(bundle.shapeSourceCounts).toEqual({ shapes: 1, route: 1, straight: 1 });
	});

	it('座標は6桁・距離は0.1m単位に丸められる', () => {
		for (const shape of Object.values(bundle.shapes)) {
			for (const [lng, lat] of shape.coords) {
				expect(lng).toBeCloseTo(Math.round(lng * 1e6) / 1e6, 10);
				expect(lat).toBeCloseTo(Math.round(lat * 1e6) / 1e6, 10);
			}
			for (const d of shape.cumDist) {
				expect(d).toBeCloseTo(Math.round(d * 10) / 10, 10);
			}
		}
	});

	it('calendar が変換される', () => {
		expect(bundle.calendar.services.WD.days).toEqual([true, true, true, true, true, false, false]);
		expect(bundle.calendar.exceptions['20260713'].WD).toBe(2);
	});

	it('重複した trip_id は最初の行が勝ち、以降はスキップされる', () => {
		const files = {
			...FIXTURE_FILES,
			'trips.txt': `route_id,service_id,trip_id,shape_id
R1,WD,T1,S1
R1,WD,T1,S1
R1,WD,T2,
R2,WD,T3,
`,
		};
		const dup = convertFeed(files, FIXTURE_ROUTES_GEOJSON);
		expect(dup.trips.filter((t) => t.tripId === 'T1').length).toBe(1);
		expect(dup.shapeSourceCounts).toEqual({ shapes: 1, route: 1, straight: 1 });
	});
});

describe('unzipFeed', () => {
	it('zipバイト列(サブフォルダ入り)からtxtを取り出せる', () => {
		const zipped = zipSync({
			'feed/stops.txt': strToU8(FIXTURE_FILES['stops.txt']),
			'feed/trips.txt': strToU8(FIXTURE_FILES['trips.txt']),
		});
		const files = unzipFeed(zipped);
		expect(Object.keys(files).sort()).toEqual(['stops.txt', 'trips.txt']);
		expect(files['stops.txt']).toContain('駅前');
	});
});
