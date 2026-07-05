import { cumulativeDistances, haversineMeters } from './geo';
import { pointAtDistance } from './interpolate';
import { projectStopsToShape } from './projection';
import type { LngLat, ShapeData } from './types';

/** routes.geojson マッチングの許容最大射影誤差(m)。超えたら直線フォールバック */
export const MAX_ROUTE_SHAPE_ERROR_M = 150;

/** route_id → ラインパーツ(頂点列)の配列 */
export type RouteLines = Record<string, LngLat[][]>;

interface RouteFeature {
	properties: { id?: string | number } | null;
	geometry:
		| { type: 'LineString'; coordinates: LngLat[] }
		| { type: 'MultiLineString'; coordinates: LngLat[][] }
		| null;
}

interface RouteFeatureCollection {
	features: RouteFeature[];
}

export function parseRouteLines(geojsonText: string): RouteLines {
	const fc = JSON.parse(geojsonText) as RouteFeatureCollection;
	const lines: RouteLines = {};
	for (const f of fc.features ?? []) {
		const id = f.properties?.id;
		if (id === undefined || id === null || !f.geometry) continue;
		const parts =
			f.geometry.type === 'LineString'
				? [f.geometry.coordinates]
				: f.geometry.type === 'MultiLineString'
					? f.geometry.coordinates
					: [];
		const valid = parts.filter((p) => p.length >= 2);
		if (valid.length > 0) (lines[String(id)] ??= []).push(...valid);
	}
	return lines;
}

export interface ShapeMatch {
	/** 候補の識別子(shapeId の一部に使う): 'concat' | 'concat-r' | 'part0' | 'part0-r' | ... */
	key: string;
	shape: ShapeData;
	/** 各停留所の累積距離(単調非減少) */
	distances: number[];
	/** 停留所と射影位置の最大距離(m) */
	maxError: number;
}

/**
 * 停留所列を路線ラインへマッチングする。
 * 候補 = 全パーツ連結・各パーツ・それぞれの逆順。停留所を単調射影し、
 * 「停留所→射影位置」の最大距離が最小の候補を返す。
 * 連結候補はパーツ間ギャップの最大値をペナルティとして持つ
 * (離れたパーツの幻の接続区間による誤マッチ防止)。連結が正当(ギャップ≈0)なら影響しない。
 * 採否判定(MAX_ROUTE_SHAPE_ERROR_M との比較)は呼び出し側が行う。
 */
export function matchStopsToRouteLines(parts: LngLat[][], stops: LngLat[]): ShapeMatch | null {
	if (parts.length === 0 || stops.length < 2) return null;
	const candidates: { key: string; coords: LngLat[]; penalty: number }[] = [];
	if (parts.length > 1) {
		const concat = ([] as LngLat[]).concat(...parts);
		let maxGap = 0;
		for (let i = 0; i < parts.length - 1; i++) {
			const gap = haversineMeters(parts[i][parts[i].length - 1], parts[i + 1][0]);
			if (gap > maxGap) maxGap = gap;
		}
		candidates.push({ key: 'concat', coords: concat, penalty: maxGap });
		candidates.push({ key: 'concat-r', coords: [...concat].reverse(), penalty: maxGap });
	}
	parts.forEach((p, i) => {
		candidates.push({ key: `part${i}`, coords: p, penalty: 0 });
		candidates.push({ key: `part${i}-r`, coords: [...p].reverse(), penalty: 0 });
	});

	let best: ShapeMatch | null = null;
	for (const cand of candidates) {
		if (cand.coords.length < 2) continue;
		const shape: ShapeData = {
			coords: cand.coords,
			cumDist: cumulativeDistances(cand.coords),
		};
		const distances = projectStopsToShape(shape, stops);
		let maxError = cand.penalty;
		for (let i = 0; i < stops.length; i++) {
			const err = haversineMeters(stops[i], pointAtDistance(shape, distances[i]));
			if (err > maxError) maxError = err;
		}
		if (!best || maxError < best.maxError) {
			best = { key: cand.key, shape, distances, maxError };
		}
	}
	return best;
}
