import type { LngLat } from './types';

export const EARTH_RADIUS_M = 6371008.8;
export const DEG = Math.PI / 180;

export function haversineMeters(a: LngLat, b: LngLat): number {
	const dLat = (b[1] - a[1]) * DEG;
	const dLng = (b[0] - a[0]) * DEG;
	const s =
		Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * DEG) * Math.cos(b[1] * DEG) * Math.sin(dLng / 2) ** 2;
	return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(s));
}

export function cumulativeDistances(coords: LngLat[]): number[] {
	const cum: number[] = coords.length === 0 ? [] : [0];
	for (let i = 1; i < coords.length; i++) {
		cum.push(cum[i - 1] + haversineMeters(coords[i - 1], coords[i]));
	}
	return cum;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** 座標群の代表点。外れ値の影響を抑えるため成分別の中央値を返す。空配列は null。 */
export function centroidOf(coords: LngLat[]): LngLat | null {
	if (coords.length === 0) return null;
	return [median(coords.map((c) => c[0])), median(coords.map((c) => c[1]))];
}
