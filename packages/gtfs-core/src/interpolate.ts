import type { LngLat, ShapeData } from './types';

/**
 * 時刻 t(秒)における累積距離。運行時間外なら null。
 * 前提: keyframes は時刻昇順(buildKeyframes の出力形式)。
 */
export function distanceAtTime(keyframes: [number, number][], t: number): number | null {
	if (Number.isNaN(t)) return null;
	if (keyframes.length < 2) return null;
	const first = keyframes[0];
	const last = keyframes[keyframes.length - 1];
	if (t < first[0] || t > last[0]) return null;
	let lo = 0;
	let hi = keyframes.length - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (keyframes[mid][0] <= t) lo = mid;
		else hi = mid;
	}
	const [t0, d0] = keyframes[lo];
	const [t1, d1] = keyframes[hi];
	if (t1 === t0) return d0;
	return d0 + ((d1 - d0) * (t - t0)) / (t1 - t0);
}

/**
 * 累積距離 d(m)に対応する shape 上の座標(範囲外・NaN はクランプ)。
 * 前提: coords は非空、cumDist は非減少(上流の変換処理が保証する不変条件)。
 */
export function pointAtDistance(shape: ShapeData, dist: number): LngLat {
	const { coords, cumDist } = shape;
	if (coords.length === 0) throw new Error('pointAtDistance: shape has no coordinates');
	const total = cumDist[cumDist.length - 1];
	const d = Number.isNaN(dist) ? 0 : Math.max(0, Math.min(dist, total));
	let lo = 0;
	let hi = cumDist.length - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (cumDist[mid] <= d) lo = mid;
		else hi = mid;
	}
	const span = cumDist[hi] - cumDist[lo];
	const t = span === 0 ? 0 : (d - cumDist[lo]) / span;
	return [
		coords[lo][0] + (coords[hi][0] - coords[lo][0]) * t,
		coords[lo][1] + (coords[hi][1] - coords[lo][1]) * t,
	];
}
