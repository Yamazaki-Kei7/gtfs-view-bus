import { parseCsv } from './csv';
import type { FeedBundle, LngLat } from './types';

export interface PointFeature {
	type: 'Feature';
	geometry: { type: 'Point'; coordinates: LngLat };
	/** routeIds は「この停留所を通る route_id」。旧データ(付与前)には無いため optional */
	properties: { stop_id: string; stop_name: string; routeIds?: string[] };
}

export interface LineFeature {
	type: 'Feature';
	geometry: { type: 'LineString'; coordinates: LngLat[] };
	properties: { shape_id: string };
}

export interface GeneratedFeatureCollection<F> {
	type: 'FeatureCollection';
	features: F[];
}

/**
 * 各停留所を通る route_id の集合を stop_times × trips から算出する。
 * trips.txt(trip_id→route_id)と stop_times.txt(stop_id)を突き合わせ、
 * 出現順を保った route_id 配列を stop_id ごとに返す。
 */
export function stopRouteIds(files: Record<string, string>): Record<string, string[]> {
	const tripRoute = new Map<string, string>();
	for (const t of parseCsv(files['trips.txt'] ?? '')) tripRoute.set(t.trip_id, t.route_id);
	const byStop = new Map<string, Set<string>>();
	for (const st of parseCsv(files['stop_times.txt'] ?? '')) {
		const routeId = tripRoute.get(st.trip_id);
		if (!routeId) continue;
		let set = byStop.get(st.stop_id);
		if (!set) {
			set = new Set();
			byStop.set(st.stop_id, set);
		}
		set.add(routeId);
	}
	const result: Record<string, string[]> = {};
	for (const [stopId, set] of byStop) result[stopId] = [...set];
	return result;
}

/** stops.txt からPointのFeatureCollectionを生成する(ソース提供のstops.geojsonが無いフィード用)。
 *  stopRoutes を渡すと各停留所に routeIds(通る route_id)を付与する。 */
export function stopsToGeojson(
	files: Record<string, string>,
	stopRoutes?: Record<string, string[]>,
): GeneratedFeatureCollection<PointFeature> {
	const features: PointFeature[] = [];
	for (const row of parseCsv(files['stops.txt'] ?? '')) {
		// Number('') は 0 になるため空欄は先に弾く
		if (!row.stop_lat || !row.stop_lon) continue;
		const lon = Number(row.stop_lon);
		const lat = Number(row.stop_lat);
		if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
		features.push({
			type: 'Feature',
			geometry: { type: 'Point', coordinates: [lon, lat] },
			properties: {
				stop_id: row.stop_id,
				stop_name: row.stop_name,
				routeIds: stopRoutes?.[row.stop_id] ?? [],
			},
		});
	}
	return { type: 'FeatureCollection', features };
}

/** 変換済みbundleのshapesからLineStringのFeatureCollectionを生成する(ソース提供のroutes.geojsonが無いフィード用) */
export function shapesToGeojson(bundle: FeedBundle): GeneratedFeatureCollection<LineFeature> {
	const features: LineFeature[] = [];
	for (const [shapeId, shape] of Object.entries(bundle.shapes)) {
		if (shape.coords.length < 2) continue;
		features.push({
			type: 'Feature',
			geometry: { type: 'LineString', coordinates: shape.coords },
			properties: { shape_id: shapeId },
		});
	}
	return { type: 'FeatureCollection', features };
}
