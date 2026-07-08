import type {
	CatalogFeed,
	FeedBundle,
	GeneratedFeatureCollection,
	LineFeature,
	LngLat,
	PointFeature,
	RouteInfo,
	TimetableIndex,
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
	/** JIS 都道府県コード(1〜47)。旧feeds.json / 未解決は null|undefined */
	prefId?: number | null;
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

/** feeds.json(インデックス)のみ取得する。都道府県セレクタと件数集計に使う。 */
export async function loadIndex(): Promise<FeedIndex> {
	const index = await fetchJson<FeedIndex>('/data/feeds.json');
	if (!index) throw new Error('feeds.json の取得に失敗しました');
	return index;
}

/** 指定フィード集合の bundle と stops を並列取得する(loadIndex 後に選択県分だけ呼ぶ)。 */
async function loadFeeds(entries: FeedIndexEntry[]): Promise<LoadedData> {
	const stops: StopFeature[] = [];
	// Promise.all は入力順で結果を返すため、feeds.json の順序が保たれる(パネルの事業者並びを毎回同一にする)
	const feeds = (
		await Promise.all(
			entries.map(async (f) => {
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
	return { stops: { type: 'FeatureCollection', features: stops }, feeds };
}

/** 指定都道府県のフィードのみロードする。 */
export function loadPrefecture(prefId: number, index: FeedIndex): Promise<LoadedData> {
	return loadFeeds(index.feeds.filter((f) => f.prefId === prefId));
}

/** フォールバック: prefId が無い(旧feeds.json / 未投入)場合に全フィードをロードする。 */
export function loadAllFeeds(index: FeedIndex): Promise<LoadedData> {
	return loadFeeds(index.feeds);
}

/** 都道府県別の登録フィード数(prefId=null は集計外)。 */
export function prefectureCounts(index: FeedIndex): Map<number, number> {
	const counts = new Map<number, number>();
	for (const f of index.feeds) {
		if (f.prefId == null) continue;
		counts.set(f.prefId, (counts.get(f.prefId) ?? 0) + 1);
	}
	return counts;
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

// 停留所別時刻表(timetable.json)はフィード単位で遅延ロードする。停留所を初めてクリックした
// ときにそのフィード分だけ取得し、多重フェッチはモジュールレベルの Promise キャッシュで防ぐ。
const timetableCache = new Map<string, Promise<TimetableIndex>>();
const EMPTY_TIMETABLE: TimetableIndex = { stops: {} };

/** 指定フィードの停留所別時刻表を取得する(取得失敗時は空インデックス=時刻表パネルは空状態)。 */
export function loadTimetable(feedId: string): Promise<TimetableIndex> {
	let p = timetableCache.get(feedId);
	if (!p) {
		p = fetchJson<TimetableIndex>(`/data/feeds/${feedId}/timetable.json`).then(
			(idx) => idx ?? EMPTY_TIMETABLE,
		);
		timetableCache.set(feedId, p);
	}
	return p;
}
