import { describe, expect, it } from 'vitest';
import { buildKeyframes } from './keyframes';

describe('buildKeyframes', () => {
	it('停車(到着≠発車)は2キーフレームになる', () => {
		const kf = buildKeyframes(
			[
				{ arrival: 28800, departure: 28800 }, // 08:00
				{ arrival: 29400, departure: 29460 }, // 08:10 着 08:11 発
				{ arrival: 30600, departure: 30600 }, // 08:30
			],
			[0, 450, 2000],
		);
		expect(kf).toEqual([
			[28800, 0],
			[29400, 450],
			[29460, 450],
			[30600, 2000],
		]);
	});

	it('時刻欠損の停留所はスキップされる', () => {
		const kf = buildKeyframes(
			[
				{ arrival: 100, departure: 100 },
				{ arrival: null, departure: null },
				{ arrival: 300, departure: 300 },
			],
			[0, 50, 100],
		);
		expect(kf).toEqual([
			[100, 0],
			[300, 100],
		]);
	});

	it('時刻の逆行はクランプされ非減少になる', () => {
		const kf = buildKeyframes(
			[
				{ arrival: 200, departure: 200 },
				{ arrival: 150, departure: 150 },
			],
			[0, 100],
		);
		expect(kf[1][0]).toBeGreaterThanOrEqual(kf[0][0]);
	});
});
