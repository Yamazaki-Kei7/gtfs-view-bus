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
	const cum: number[] = [0];
	for (let i = 1; i < coords.length; i++) {
		cum.push(cum[i - 1] + haversineMeters(coords[i - 1], coords[i]));
	}
	return cum;
}
