import { DEG, EARTH_RADIUS_M } from './geo';
import type { LngLat, ShapeData } from './types';

/** 短距離用の局所平面近似(equirectangular) */
function toXY(p: LngLat, cosLat: number): [number, number] {
	return [p[0] * DEG * EARTH_RADIUS_M * cosLat, p[1] * DEG * EARTH_RADIUS_M];
}

interface Projection {
	dist: number;
	segment: number;
	/** 見つかったセグメント内のオフセット(0〜1) */
	t: number;
}

/**
 * 点をポリラインへ射影する。minSegment より前のセグメントは探索せず、
 * minSegment 自体では t >= minT に制限する(=直前の射影位置より後ろへ戻らない)。
 */
export function projectPointToPolyline(
	coords: LngLat[],
	cumDist: number[],
	point: LngLat,
	minSegment = 0,
	minT = 0,
): Projection {
	if (coords.length === 0) return { dist: 0, segment: 0, t: 0 };
	const cosLat = Math.cos(point[1] * DEG);
	const p = toXY(point, cosLat);
	let bestDist = cumDist[cumDist.length - 1];
	let bestSegment = Math.max(coords.length - 2, 0);
	let bestT = 1;
	let bestD2 = Infinity;
	// 実質的な同点では先に見つかったセグメント(=より手前側)を優先する。
	// 折り返し・ループ路線では往路と復路が同一線上に重なり、浮動小数点誤差だけで
	// どちらが「最近傍」か決まってしまうため、相対許容誤差を設けて更新条件を
	// 厳しくし、単調増加制約に沿った選択を保証する。
	const TIE_EPS = 1e-9;
	for (let i = Math.max(0, minSegment); i < coords.length - 1; i++) {
		const a = toXY(coords[i], cosLat);
		const b = toXY(coords[i + 1], cosLat);
		const abx = b[0] - a[0];
		const aby = b[1] - a[1];
		const len2 = abx * abx + aby * aby;
		const tLo = i === minSegment ? minT : 0;
		const raw = len2 === 0 ? 0 : ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2;
		const t = Math.max(tLo, Math.min(1, raw));
		const qx = a[0] + t * abx;
		const qy = a[1] + t * aby;
		const dx = p[0] - qx;
		const dy = p[1] - qy;
		const d2 = dx * dx + dy * dy;
		const scale = Math.max(len2, 1);
		if (d2 < bestD2 - scale * TIE_EPS) {
			bestD2 = d2;
			bestSegment = i;
			bestT = t;
			bestDist = cumDist[i] + (cumDist[i + 1] - cumDist[i]) * t;
		}
	}
	return { dist: bestDist, segment: bestSegment, t: bestT };
}

/**
 * 各停留所をshapeポリラインへ射影し、累積距離(m)の列を返す。
 * 直前の停留所の射影位置(セグメント番号+セグメント内オフセット)より
 * 手前には戻らない単調増加制約付き。折り返し・ループ路線での誤マッチを防ぐ。
 */
export function projectStopsToShape(shape: ShapeData, stops: LngLat[]): number[] {
	const result: number[] = [];
	let segment = 0;
	let t = 0;
	let prev = 0;
	for (const stop of stops) {
		const r = projectPointToPolyline(shape.coords, shape.cumDist, stop, segment, t);
		const d = Math.max(r.dist, prev);
		result.push(d);
		segment = r.segment;
		t = r.t;
		prev = d;
	}
	return result;
}
