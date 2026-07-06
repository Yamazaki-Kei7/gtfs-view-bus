import type { FeedBundle } from 'gtfs-core';

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
	feeds: { id: string; bundle: FeedBundle }[];
	stops: GeoJsonFeatureCollection;
	routes: GeoJsonFeatureCollection;
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
	const feeds: LoadedData['feeds'] = [];
	const stops: GeoJsonFeatureCollection = { type: 'FeatureCollection', features: [] };
	const routes: GeoJsonFeatureCollection = { type: 'FeatureCollection', features: [] };
	await Promise.all(
		index.feeds.map(async (f) => {
			const [bundle, s, r] = await Promise.all([
				fetchJson<FeedBundle>(`/data/feeds/${f.id}/bundle.json`),
				fetchJson<GeoJsonFeatureCollection>(`/data/feeds/${f.id}/stops.geojson`),
				fetchJson<GeoJsonFeatureCollection>(`/data/feeds/${f.id}/routes.geojson`),
			]);
			if (bundle) feeds.push({ id: f.id, bundle });
			if (s) stops.features.push(...s.features);
			if (r) routes.features.push(...r.features);
		}),
	);
	return { index, feeds, stops, routes };
}
