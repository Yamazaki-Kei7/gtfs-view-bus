import type {
	CatalogFeed,
	FeedBundle,
	GeneratedFeatureCollection,
	LineFeature,
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

interface GeoJsonFeatureCollection {
	type: 'FeatureCollection';
	features: object[];
}

export interface LoadedData {
	index: FeedIndex;
	feeds: CatalogFeed[];
	stops: GeoJsonFeatureCollection;
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
	const feeds: CatalogFeed[] = [];
	const stops: GeoJsonFeatureCollection = { type: 'FeatureCollection', features: [] };
	await Promise.all(
		index.feeds.map(async (f) => {
			const [bundle, s] = await Promise.all([
				fetchJson<FeedBundle>(`/data/feeds/${f.id}/bundle.json`),
				fetchJson<GeoJsonFeatureCollection>(`/data/feeds/${f.id}/stops.geojson`),
			]);
			if (bundle) feeds.push({ id: f.id, name: f.name, bundle });
			if (s) stops.features.push(...s.features);
		}),
	);
	return { index, feeds, stops };
}

interface RouteLineFeature {
	type: 'Feature';
	geometry: LineFeature['geometry'];
	properties: { color: string };
}

export type RouteLineCollection = GeneratedFeatureCollection<RouteLineFeature>;

/**
 * 路線線(色分け)の GeoJSON をクライアントで生成する。
 * routes.geojson はソースごとにプロパティが不定なため使わず、bundle.shapes を
 * trips 経由で route に結び付け、選択日に運行中(active)かつ非表示でない路線のみを描画する。
 */
export function buildRouteLines(
	feeds: CatalogFeed[],
	catalog: RouteInfo[],
	hidden: Record<string, boolean>,
): RouteLineCollection {
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
			if (!info || !info.active || hidden[info.key]) continue;
			features.push({
				type: 'Feature',
				geometry: { type: 'LineString', coordinates: shape.coords },
				properties: { color: info.color },
			});
		}
	}
	return { type: 'FeatureCollection', features };
}
