import { strToU8, zipSync } from 'fflate';
import { FIXTURE_FILES, FIXTURE_ROUTES_GEOJSON } from 'gtfs-core';
import { describe, expect, it } from 'vitest';
import { runPipeline, type BucketLike } from './run';
import { createGtfsDataJpSource, type GtfsFileEntry } from './sources/gtfsDataJp';
import type { FeedDescriptor, FeedSource } from './sources/types';

function fakeBucket(): BucketLike & { store: Map<string, string>; deleted: string[] } {
	const store = new Map<string, string>();
	const deleted: string[] = [];
	return {
		store,
		deleted,
		async get(key: string) {
			const v = store.get(key);
			return v === undefined ? null : { text: async () => v };
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
		async list({ prefix }: { prefix: string; cursor?: string }) {
			return {
				objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
				truncated: false,
			};
		},
		async delete(keys: string[]) {
			deleted.push(...keys);
			for (const k of keys) store.delete(k);
		},
	};
}

function entry(overrides: Partial<GtfsFileEntry>): GtfsFileEntry {
	return {
		organization_id: 'testorg',
		organization_name: 'テスト協議会',
		feed_id: 'testfeed',
		feed_name: 'テストバス',
		feed_license_id: 'CC BY 4.0',
		file_uid: 'uid-1',
		file_from_date: '2026-04-01',
		file_to_date: '2027-03-31',
		file_url: 'https://example.com/feed.zip',
		file_stop_url: 'https://example.com/stops.geojson',
		file_route_url: 'https://example.com/routes.geojson',
		file_last_updated_at: '2026-06-01T00:00:00+09:00',
		...overrides,
	};
}

const FIXTURE_ZIP = zipSync(
	Object.fromEntries(Object.entries(FIXTURE_FILES).map(([k, v]) => [k, strToU8(v)])),
);

function fetcherFor(entries: GtfsFileEntry[]): typeof fetch {
	const impl = async (input: RequestInfo | URL): Promise<Response> => {
		const url = String(input);
		if (url.includes('/v2/files')) {
			return new Response(JSON.stringify({ code: 200, message: 'ok', body: entries }));
		}
		if (url.endsWith('feed.zip')) return new Response(FIXTURE_ZIP);
		if (url.endsWith('routes.geojson')) return new Response(FIXTURE_ROUTES_GEOJSON);
		if (url.endsWith('.geojson')) {
			return new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }));
		}
		return new Response('not found', { status: 404 });
	};
	return impl as typeof fetch;
}

/** GeoJSON別配布の無いODPT風フィードを模した記述子 */
function odptDescriptor(): FeedDescriptor {
	return {
		id: 'odpt~TestOp~AllLines',
		name: 'テスト事業者(全路線)',
		orgName: 'テスト事業者',
		license: 'CC BY 4.0',
		fromDate: '',
		toDate: '',
		source: 'odpt',
		versionId: '/files-open/odpt/TestOp/AllLines-20260601.zip',
		fetchZip: async () => FIXTURE_ZIP,
	};
}

function stubSource(descriptors: FeedDescriptor[]): FeedSource {
	return { sourceId: 'odpt', listFeeds: async () => descriptors };
}

describe('runPipeline', () => {
	it('新規フィードを変換してR2へ書き込み、feeds.jsonを更新する', async () => {
		const bucket = fakeBucket();
		const statuses = await runPipeline({
			bucket,
			fetcher: fetcherFor([entry({})]),
			sources: [createGtfsDataJpSource('10')],
		});
		expect(statuses).toHaveLength(1);
		expect(statuses[0].status).toBe('updated');
		expect(statuses[0].source).toBe('gtfs-data.jp');
		const id = 'testorg~testfeed~2026-04-01';
		expect(bucket.store.has(`feeds/${id}/bundle.json`)).toBe(true);
		expect(bucket.store.has(`feeds/${id}/stops.geojson`)).toBe(true);
		// ソース提供のroutes.geojsonはそのまま保存される
		expect(bucket.store.get(`feeds/${id}/routes.geojson`)).toBe(FIXTURE_ROUTES_GEOJSON);
		expect(bucket.store.has(`feeds/${id}/meta.json`)).toBe(true);
		const index = JSON.parse(bucket.store.get('feeds.json') ?? '{}') as {
			feeds: { id: string; status: string; source: string }[];
		};
		expect(index.feeds[0].id).toBe(id);
		expect(index.feeds[0].source).toBe('gtfs-data.jp');
		// フィクスチャ: T1=shapes.txt / T3=routes.geojsonマッチ / T2=直線フォールバック
		expect(statuses[0].shapeSourceCounts).toEqual({ shapes: 1, route: 1, straight: 1 });
	});

	it('versionId が同じなら unchanged でスキップし、shapeSourceCounts を引き継ぐ', async () => {
		const bucket = fakeBucket();
		const deps = {
			bucket,
			fetcher: fetcherFor([entry({})]),
			sources: [createGtfsDataJpSource('10')],
		};
		await runPipeline(deps);
		const second = await runPipeline(deps);
		expect(second[0].status).toBe('unchanged');
		expect(second[0].shapeSourceCounts).toEqual({ shapes: 1, route: 1, straight: 1 });
	});

	it('旧形式meta(fileUid)でもunchanged判定できる', async () => {
		const bucket = fakeBucket();
		const id = 'testorg~testfeed~2026-04-01';
		bucket.store.set(
			`feeds/${id}/meta.json`,
			JSON.stringify({ fileUid: 'uid-1', shapeSourceCounts: { shapes: 3, route: 0, straight: 0 } }),
		);
		const statuses = await runPipeline({
			bucket,
			fetcher: fetcherFor([entry({})]),
			sources: [createGtfsDataJpSource('10')],
		});
		expect(statuses[0].status).toBe('unchanged');
		expect(statuses[0].shapeSourceCounts).toEqual({ shapes: 3, route: 0, straight: 0 });
	});

	it('1フィードの失敗が他フィードを巻き込まない', async () => {
		const bucket = fakeBucket();
		const bad = entry({
			organization_id: 'badorg',
			file_url: 'https://example.com/missing.zip',
		});
		const statuses = await runPipeline({
			bucket,
			fetcher: fetcherFor([bad, entry({})]),
			sources: [createGtfsDataJpSource('10')],
		});
		expect(statuses.find((s) => s.id.startsWith('badorg'))?.status).toBe('error');
		expect(statuses.find((s) => s.id.startsWith('testorg'))?.status).toBe('updated');
	});

	it('GeoJSON未提供のフィードはGTFSからstops/routesを生成する', async () => {
		const bucket = fakeBucket();
		const statuses = await runPipeline({
			bucket,
			fetcher: fetcherFor([]),
			sources: [stubSource([odptDescriptor()])],
		});
		expect(statuses[0].status).toBe('updated');
		const stops = JSON.parse(
			bucket.store.get('feeds/odpt~TestOp~AllLines/stops.geojson') ?? '{}',
		) as { features: object[] };
		expect(stops.features).toHaveLength(3);
		const routes = JSON.parse(
			bucket.store.get('feeds/odpt~TestOp~AllLines/routes.geojson') ?? '{}',
		) as { features: object[] };
		expect(routes.features.length).toBeGreaterThan(0);
	});

	it('どのソースにも属さない旧フィードのキーを削除する', async () => {
		const bucket = fakeBucket();
		bucket.store.set('feeds/testorg~testfeed~2025-01-01/bundle.json', '{}');
		bucket.store.set('feeds/testorg~testfeed~2025-01-01/meta.json', '{}');
		await runPipeline({
			bucket,
			fetcher: fetcherFor([entry({})]),
			sources: [createGtfsDataJpSource('10')],
		});
		expect(bucket.store.has('feeds/testorg~testfeed~2025-01-01/bundle.json')).toBe(false);
		expect(bucket.store.has('feeds/testorg~testfeed~2025-01-01/meta.json')).toBe(false);
		expect(bucket.store.has('feeds/testorg~testfeed~2026-04-01/bundle.json')).toBe(true);
	});

	it('エラーになったフィードの既存データは削除しない', async () => {
		const bucket = fakeBucket();
		const bad = entry({
			organization_id: 'badorg',
			file_url: 'https://example.com/missing.zip',
		});
		bucket.store.set('feeds/badorg~testfeed~2026-04-01/bundle.json', '{}');
		const statuses = await runPipeline({
			bucket,
			fetcher: fetcherFor([bad]),
			sources: [createGtfsDataJpSource('10')],
		});
		expect(statuses[0].status).toBe('error');
		expect(bucket.store.has('feeds/badorg~testfeed~2026-04-01/bundle.json')).toBe(true);
	});

	it('ソース一覧の取得失敗時は前回エントリを引き継ぎ、掃除をスキップする', async () => {
		const bucket = fakeBucket();
		bucket.store.set(
			'feeds.json',
			JSON.stringify({
				generatedAt: '2026-07-01T00:00:00Z',
				feeds: [
					{
						id: 'odpt~A~B',
						name: '前回フィード',
						orgName: 'o',
						license: 'CC BY 4.0',
						fromDate: '',
						toDate: '',
						source: 'odpt',
						status: 'updated',
					},
				],
			}),
		);
		bucket.store.set('feeds/odpt~A~B/bundle.json', '{}');
		const failingSource: FeedSource = {
			sourceId: 'odpt',
			listFeeds: () => Promise.reject(new Error('down')),
		};
		const statuses = await runPipeline({
			bucket,
			fetcher: fetcherFor([]),
			sources: [failingSource],
		});
		expect(statuses).toHaveLength(1);
		expect(statuses[0].id).toBe('odpt~A~B');
		expect(bucket.deleted).toHaveLength(0);
		expect(bucket.store.has('feeds/odpt~A~B/bundle.json')).toBe(true);
	});

	it('片側ソースの一覧失敗がもう片方の処理を妨げない', async () => {
		const bucket = fakeBucket();
		const failingSource: FeedSource = {
			sourceId: 'odpt',
			listFeeds: () => Promise.reject(new Error('down')),
		};
		const statuses = await runPipeline({
			bucket,
			fetcher: fetcherFor([entry({})]),
			sources: [createGtfsDataJpSource('10'), failingSource],
		});
		expect(statuses).toHaveLength(1);
		expect(statuses[0].status).toBe('updated');
	});
});
