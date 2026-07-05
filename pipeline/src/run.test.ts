import { strToU8, zipSync } from 'fflate';
import { FIXTURE_FILES, FIXTURE_ROUTES_GEOJSON } from 'gtfs-core';
import { describe, expect, it } from 'vitest';
import { runPipeline, type BucketLike, type GtfsFileEntry } from './run';

function fakeBucket(): BucketLike & { store: Map<string, string> } {
	const store = new Map<string, string>();
	return {
		store,
		async get(key: string) {
			const v = store.get(key);
			return v === undefined ? null : { text: async () => v };
		},
		async put(key: string, value: string) {
			store.set(key, value);
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

describe('runPipeline', () => {
	it('新規フィードを変換してR2へ書き込み、feeds.jsonを更新する', async () => {
		const bucket = fakeBucket();
		const statuses = await runPipeline({
			bucket,
			fetcher: fetcherFor([entry({})]),
			prefId: '10',
		});
		expect(statuses).toHaveLength(1);
		expect(statuses[0].status).toBe('updated');
		const id = 'testorg~testfeed~2026-04-01';
		expect(bucket.store.has(`feeds/${id}/bundle.json`)).toBe(true);
		expect(bucket.store.has(`feeds/${id}/stops.geojson`)).toBe(true);
		expect(bucket.store.has(`feeds/${id}/routes.geojson`)).toBe(true);
		expect(bucket.store.has(`feeds/${id}/meta.json`)).toBe(true);
		const index = JSON.parse(bucket.store.get('feeds.json') ?? '{}') as {
			feeds: { id: string; status: string }[];
		};
		expect(index.feeds[0].id).toBe(id);
		// フィクスチャ: T1=shapes.txt / T3=routes.geojsonマッチ / T2=直線フォールバック
		expect(statuses[0].shapeSourceCounts).toEqual({ shapes: 1, route: 1, straight: 1 });
	});

	it('file_uid が同じなら unchanged でスキップする', async () => {
		const bucket = fakeBucket();
		const deps = { bucket, fetcher: fetcherFor([entry({})]), prefId: '10' };
		await runPipeline(deps);
		const second = await runPipeline(deps);
		expect(second[0].status).toBe('unchanged');
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
			prefId: '10',
		});
		expect(statuses.find((s) => s.id.startsWith('badorg'))?.status).toBe('error');
		expect(statuses.find((s) => s.id.startsWith('testorg'))?.status).toBe('updated');
	});
});
