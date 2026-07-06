import type {
	CatalogFeed,
	FeedBundle,
	GeneratedFeatureCollection,
	LineFeature,
	LngLat,
	PointFeature,
	RouteInfo,
} from 'gtfs-core';

export interface FeedIndexEntry {
	id: string;
	name: string;
	orgName: string;
	license: string | null;
	fromDate: string;
	toDate: string;
	status: string;
	/** 取得元レジストリ。旧feeds.json(移行前)には無いためoptional */
	source?: string;
}

export interface FeedIndex {
	generatedAt: string;
	feeds: FeedIndexEntry[];
}

/** アプリ描画用に整形した停留所。routeKeys は `${feedId}|${routeId}` の配列
 *  (旧データ=routeIds 無しは undefined:分類不能フォールバックの印) */
export interface StopFeature {
	type: 'Feature';
	geometry: { type: 'Point'; coordinates: LngLat };
	properties: { stopId: string; name: string; feedId: string; routeKeys: string[] | undefined };
}

export interface LoadedData {
	index: FeedIndex;
	feeds: CatalogFeed[];
	stops: GeneratedFeatureCollection<StopFeature>;
}

async function fetchJson<T>(url: string): Promise<T | null> {
	const res = await fetch(url);
	if (!res.ok) {
		console.warn(`fetch failed: ${url} (${res.status})`);
		return null;
	}
	return (await res.json()) as T;
}

export async function loadAll(): Promise<LoadedData> {
	const index = await fetchJson<FeedIndex>('/data/feeds.json');
	if (!index) throw new Error('feeds.json の取得に失敗しました');
	const stops: StopFeature[] = [];
	// Promise.all は入力順で結果を返すため、feeds.json の順序が保たれる(パネルの事業者並びを毎回同一にする)
	const feeds = (
		await Promise.all(
			index.feeds.map(async (f) => {
				const [bundle, s] = await Promise.all([
					fetchJson<FeedBundle>(`/data/feeds/${f.id}/bundle.json`),
					fetchJson<GeneratedFeatureCollection<PointFeature>>(`/data/feeds/${f.id}/stops.geojson`),
				]);
				if (s) {
					for (const feat of s.features) {
						stops.push({
							type: 'Feature',
							geometry: feat.geometry,
							properties: {
								stopId: feat.properties.stop_id,
								name: feat.properties.stop_name,
								feedId: f.id,
								// routeIds 無し(再生成前の旧データ)は undefined にして分類不能フォールバックへ
								routeKeys: feat.properties.routeIds
									? feat.properties.routeIds.map((rid) => `${f.id}|${rid}`)
									: undefined,
							},
						});
					}
				}
				return bundle ? { id: f.id, name: f.name, bundle } : null;
			}),
		)
	).filter((f): f is CatalogFeed => f !== null);
	return { index, feeds, stops: { type: 'FeatureCollection', features: stops } };
}

interface RouteLineFeature {
	type: 'Feature';
	geometry: LineFeature['geometry'];
	/** color/key は描画・参照用。active は当日運行フラグ(運休路線の描き分け用) */
	properties: { color: string; key: string; active: boolean };
}

export type RouteLineCollection = GeneratedFeatureCollection<RouteLineFeature>;

/**
 * 路線線(色分け)の GeoJSON をクライアントで生成する。
 * bundle.shapes を trips 経由で route に結び付け、当日運行(active)フラグを付けて全路線を出力する。
 * 運行/運休の描き分けと非表示路線の除外はレイヤ側の filter で行う。
 */
export function buildRouteLines(feeds: CatalogFeed[], catalog: RouteInfo[]): RouteLineCollection {
	const byKey = new Map(catalog.map((r) => [r.key, r]));
	const features: RouteLineFeature[] = [];
	for (const { id, bundle } of feeds) {
		// shapeId → routeId(最初に見つかった trip の route を採用)
		const shapeRoute = new Map<string, string>();
		for (const trip of bundle.trips) {
			if (!shapeRoute.has(trip.shapeId)) shapeRoute.set(trip.shapeId, trip.routeId);
		}
		for (const [shapeId, shape] of Object.entries(bundle.shapes)) {
			if (shape.coords.length < 2) continue;
			const routeId = shapeRoute.get(shapeId);
			if (!routeId) continue;
			const info = byKey.get(`${id}|${routeId}`);
			if (!info) continue;
			features.push({
				type: 'Feature',
				geometry: { type: 'LineString', coordinates: shape.coords },
				properties: { color: info.color, key: info.key, active: info.active },
			});
		}
	}
	return { type: 'FeatureCollection', features };
}
