import { describe, expect, it } from 'vitest';
import { cumulativeDistances } from './geo';
import { distanceAtTime, pointAtDistance } from './interpolate';
import type { ShapeData } from './types';

describe('distanceAtTime', () => {
	const kf: [number, number][] = [
		[28800, 0],
		[29400, 450],
		[30600, 2000],
	];

	it('キーフレーム間を線形補間する', () => {
		expect(distanceAtTime(kf, 28800)).toBe(0);
		expect(distanceAtTime(kf, 29100)).toBeCloseTo(225, 6); // 中間
		expect(distanceAtTime(kf, 30600)).toBe(2000);
	});

	it('運行時間外は null', () => {
		expect(distanceAtTime(kf, 28799)).toBeNull();
		expect(distanceAtTime(kf, 30601)).toBeNull();
	});

	it('キーフレームが2未満なら null', () => {
		expect(distanceAtTime([[100, 0]], 100)).toBeNull();
	});

	it('時刻が NaN なら null', () => {
		expect(distanceAtTime(kf, NaN)).toBeNull();
	});
});

describe('pointAtDistance', () => {
	const shape: ShapeData = (() => {
		const coords: [number, number][] = [
			[139.0, 36.0],
			[139.01, 36.0],
		];
		return { coords, cumDist: cumulativeDistances(coords) };
	})();

	it('距離0は始点、全長は終点', () => {
		expect(pointAtDistance(shape, 0)).toEqual([139.0, 36.0]);
		const end = pointAtDistance(shape, shape.cumDist[1]);
		expect(end[0]).toBeCloseTo(139.01, 8);
	});

	it('中間距離は線分上を補間する', () => {
		const mid = pointAtDistance(shape, shape.cumDist[1] / 2);
		expect(mid[0]).toBeCloseTo(139.005, 5);
		expect(mid[1]).toBeCloseTo(36.0, 8);
	});

	it('範囲外はクランプされる', () => {
		expect(pointAtDistance(shape, -10)).toEqual([139.0, 36.0]);
		expect(pointAtDistance(shape, 1e9)[0]).toBeCloseTo(139.01, 8);
	});

	it('距離が NaN なら始点にクランプされる', () => {
		expect(pointAtDistance(shape, NaN)).toEqual([139.0, 36.0]);
	});

	it('空の shape は例外を投げる', () => {
		expect(() => pointAtDistance({ coords: [], cumDist: [] }, 0)).toThrow();
	});

	it('頂点1つの shape は任意の距離でその点を返す', () => {
		const single: ShapeData = { coords: [[139.0, 36.0]], cumDist: [0] };
		expect(pointAtDistance(single, 0)).toEqual([139.0, 36.0]);
		expect(pointAtDistance(single, 500)).toEqual([139.0, 36.0]);
	});
});
