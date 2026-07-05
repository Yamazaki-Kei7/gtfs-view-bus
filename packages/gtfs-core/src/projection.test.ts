import { describe, expect, it } from 'vitest';
import { cumulativeDistances } from './geo';
import { projectStopsToShape } from './projection';
import type { LngLat, ShapeData } from './types';

function makeShape(coords: LngLat[]): ShapeData {
	return { coords, cumDist: cumulativeDistances(coords) };
}

describe('projectStopsToShape', () => {
	it('L字型shape上の停留所を累積距離に変換する', () => {
		// 東へ約900m、その後北へ約1113m のL字
		const shape = makeShape([
			[139.0, 36.0],
			[139.01, 36.0],
			[139.01, 36.01],
		]);
		const stops: LngLat[] = [
			[139.0, 36.0], // 起点
			[139.005, 36.0001], // 第1セグメント中間(少し北にずれた位置)
			[139.01, 36.01], // 終点
		];
		const dists = projectStopsToShape(shape, stops);
		expect(dists[0]).toBeCloseTo(0, 0);
		expect(dists[1]).toBeGreaterThan(shape.cumDist[1] * 0.4);
		expect(dists[1]).toBeLessThan(shape.cumDist[1] * 0.6);
		expect(dists[2]).toBeCloseTo(shape.cumDist[2], 0);
	});

	it('折り返し路線では単調増加制約により復路側に射影される', () => {
		// 東へ約1113m 進んで同じ道を戻る(赤道上で計算しやすく)
		const shape = makeShape([
			[0.0, 0.0],
			[0.01, 0.0],
			[0.0, 0.0],
		]);
		const total = shape.cumDist[2];
		const stops: LngLat[] = [
			[0.006, 0.0], // 往路
			[0.004, 0.0], // 単純最近傍なら往路445m地点だが、復路でなければならない
		];
		const dists = projectStopsToShape(shape, stops);
		expect(dists[0]).toBeCloseTo(total * 0.3, -1); // 668m 付近
		expect(dists[1]).toBeGreaterThan(shape.cumDist[1]); // 折り返し点より先
		expect(dists[1]).toBeGreaterThan(dists[0]);
	});

	it('結果は常に単調非減少', () => {
		const shape = makeShape([
			[139.0, 36.0],
			[139.01, 36.0],
		]);
		// 2番目の停留所が1番目より手前にあるデータ不備でも逆行しない
		const dists = projectStopsToShape(shape, [
			[139.006, 36.0],
			[139.004, 36.0],
		]);
		expect(dists[1]).toBeGreaterThanOrEqual(dists[0]);
	});
});
