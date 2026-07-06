import { parseCsv } from './csv';
import type { FeedBundle, LngLat } from './types';

export interface PointFeature {
	type: 'Feature';
	geometry: { type: 'Point'; coordinates: LngLat };
	properties: { stop_id: string; stop_name: string };
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

/** stops.txt からPointのFeatureCollectionを生成する(ソース提供のstops.geojsonが無いフィード用) */
export function stopsToGeojson(
	files: Record<string, string>,
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
			properties: { stop_id: row.stop_id, stop_name: row.stop_name },
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
