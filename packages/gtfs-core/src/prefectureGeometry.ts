import geojson from './prefectures.geo.json';
import type { LngLat } from './types';

type Ring = number[][];
interface PrefFeature {
	type: 'Feature';
	properties: { id: number };
	geometry:
		| { type: 'Polygon'; coordinates: Ring[] }
		| { type: 'MultiPolygon'; coordinates: Ring[][] };
}
export interface PrefectureFeatureCollection {
	type: 'FeatureCollection';
	features: PrefFeature[];
}

export const PREFECTURES_GEOJSON = geojson as PrefectureFeatureCollection;

/** 内包なし時の最近傍フォールバックを許す最大距離(度)。約60km相当。 */
const NEAREST_MAX_DEG = 0.6;

function pointInRing(lng: number, lat: number, ring: Ring): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const xi = ring[i][0];
		const yi = ring[i][1];
		const xj = ring[j][0];
		const yj = ring[j][1];
		const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
		if (intersect) inside = !inside;
	}
	return inside;
}

/** 1つ目のリングを外周、以降を穴として point-in-polygon 判定する。 */
function pointInPolygon(lng: number, lat: number, rings: Ring[]): boolean {
	if (rings.length === 0 || !pointInRing(lng, lat, rings[0])) return false;
	for (let i = 1; i < rings.length; i++) {
		if (pointInRing(lng, lat, rings[i])) return false; // 穴の中
	}
	return true;
}

function featureContains(lng: number, lat: number, f: PrefFeature): boolean {
	if (f.geometry.type === 'Polygon') return pointInPolygon(lng, lat, f.geometry.coordinates);
	return f.geometry.coordinates.some((poly) => pointInPolygon(lng, lat, poly));
}

function ringsOf(f: PrefFeature): Ring[] {
	return f.geometry.type === 'Polygon' ? f.geometry.coordinates : f.geometry.coordinates.flat();
}

/**
 * 座標が属する都道府県コードを返す。まず point-in-polygon で内包判定し、内包が無ければ一定距離内で
 * 最近傍の外周頂点を持つ県へフォールバックする(海岸沿いの重心が簡略化ポリゴンからわずかに外れる救済)。
 * どれにも当てはまらなければ null。
 */
export function resolvePrefId(lng: number, lat: number): number | null {
	for (const f of PREFECTURES_GEOJSON.features) {
		if (featureContains(lng, lat, f)) return f.properties.id;
	}
	let bestId: number | null = null;
	let bestDist = NEAREST_MAX_DEG;
	for (const f of PREFECTURES_GEOJSON.features) {
		for (const ring of ringsOf(f)) {
			for (const [x, y] of ring) {
				const d = Math.hypot(x - lng, y - lat);
				if (d < bestDist) {
					bestDist = d;
					bestId = f.properties.id;
				}
			}
		}
	}
	return bestId;
}
