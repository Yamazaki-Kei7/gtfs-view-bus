import { strToU8, zipSync } from 'fflate';
import { FIXTURE_FILES, FIXTURE_ROUTES_GEOJSON } from 'gtfs-core';
import { describe, expect, it } from 'vitest';
import { processFeedTarget } from './feedProcessor';
import type { BucketLike } from './storage';
import type { FeedTarget } from './sources/types';

function fakeBucket(): BucketLike & { store: Map<string, string>; writes: string[] } {
	const store = new Map<string, string>();
	const writes: string[] = [];
	return {
		store,
		writes,
		async get(key: string) {
			const v = store.get(key);
			return v === undefined ? null : { text: async () => v };
		},
		async put(key: string, value: string) {
			writes.push(key);
			store.set(key, value);
		},
		async list() {
			return { objects: [], truncated: false };
		},
		async delete() {},
	};
}

const FIXTURE_ZIP = zipSync(
	Object.fromEntries(Object.entries(FIXTURE_FILES).map(([k, v]) => [k, strToU8(v)])),
);

function target(overrides: Partial<FeedTarget> = {}): FeedTarget {
	return {
		id: 'testorg~testfeed~2026-04-01',
		name: 'テストバス',
		orgName: 'テスト協議会',
		license: 'CC BY 4.0',
		fromDate: '2026-04-01',
		toDate: '2027-03-31',
		source: 'gtfs-data.jp',
		versionId: 'uid-1',
		zipUrl: 'https://example.com/feed.zip',
		routesGeojsonUrl: 'https://example.com/routes.geojson',
		...overrides,
	};
}

function fetcher(): typeof fetch {
	const impl = async (input: RequestInfo | URL): Promise<Response> => {
		const url = String(input);
		if (url.endsWith('feed.zip')) return new Response(FIXTURE_ZIP);
		if (url.endsWith('routes.geojson')) return new Response(FIXTURE_ROUTES_GEOJSON);
		return new Response('not found', { status: 404 });
	};
	return impl as typeof fetch;
}

describe('processFeedTarget', () => {
	it('新規フィードを変換し、meta.jsonを最後に書く', async () => {
		const bucket = fakeBucket();
		const status = await processFeedTarget({ bucket, fetcher: fetcher(), target: target() });
		expect(status.status).toBe('updated');
		expect(bucket.store.has('feeds/testorg~testfeed~2026-04-01/bundle.json')).toBe(true);
		expect(bucket.store.has('feeds/testorg~testfeed~2026-04-01/routes.geojson')).toBe(true);
		expect(bucket.store.has('feeds/testorg~testfeed~2026-04-01/stops.geojson')).toBe(true);
		expect(bucket.store.has('feeds/testorg~testfeed~2026-04-01/timetable.json')).toBe(true);
		expect(bucket.writes.at(-1)).toBe('feeds/testorg~testfeed~2026-04-01/meta.json');
		expect(status.shapeSourceCounts).toEqual({ shapes: 1, route: 1, straight: 1 });
	});

	it('versionIdとschemaVersionが一致すればunchangedで変換をスキップする', async () => {
		const bucket = fakeBucket();
		bucket.store.set(
			'feeds/testorg~testfeed~2026-04-01/meta.json',
			JSON.stringify({
				versionId: 'uid-1',
				schemaVersion: 4,
				shapeSourceCounts: { shapes: 2, route: 0, straight: 0 },
			}),
		);
		const status = await processFeedTarget({ bucket, fetcher: fetcher(), target: target() });
		expect(status.status).toBe('unchanged');
		expect(status.shapeSourceCounts).toEqual({ shapes: 2, route: 0, straight: 0 });
		expect(bucket.writes).toHaveLength(0);
	});

	it('通常のフィード処理失敗はthrowせずerror statusを返す', async () => {
		const bucket = fakeBucket();
		const status = await processFeedTarget({
			bucket,
			fetcher: fetcher(),
			target: target({ zipUrl: 'https://example.com/missing.zip' }),
		});
		expect(status.status).toBe('error');
		expect(status.error).toBe('zip fetch failed: 404');
	});

	it('target.prefIdがあればstatusとmetaに反映する', async () => {
		const bucket = fakeBucket();
		const status = await processFeedTarget({
			bucket,
			fetcher: fetcher(),
			target: target({ prefId: 13 }),
		});
		expect(status.prefId).toBe(13);
		const meta = JSON.parse(
			bucket.store.get('feeds/testorg~testfeed~2026-04-01/meta.json') ?? '{}',
		) as { prefId?: number | null };
		expect(meta.prefId).toBe(13);
	});

	it('target.prefId無しは停留所重心のresolvePrefId結果(数値 or null)になる', async () => {
		const bucket = fakeBucket();
		const status = await processFeedTarget({
			bucket,
			fetcher: fetcher(),
			target: target({ prefId: undefined, source: 'odpt' }),
		});
		expect(status.prefId === null || typeof status.prefId === 'number').toBe(true);
	});

	it('unchanged時はtarget.prefId ?? meta.prefIdを使う', async () => {
		const bucket = fakeBucket();
		bucket.store.set(
			'feeds/testorg~testfeed~2026-04-01/meta.json',
			JSON.stringify({
				versionId: 'uid-1',
				schemaVersion: 4,
				shapeSourceCounts: { shapes: 2, route: 0, straight: 0 },
				prefId: 21,
			}),
		);
		const status = await processFeedTarget({
			bucket,
			fetcher: fetcher(),
			target: target({ prefId: undefined }),
		});
		expect(status.status).toBe('unchanged');
		expect(status.prefId).toBe(21);
	});

	it('R2書き込み失敗はerror statusに丸めずthrowする', async () => {
		const bucket = fakeBucket();
		const failingBucket: BucketLike = {
			...bucket,
			async put(key, value) {
				if (key.endsWith('/bundle.json')) throw new Error('R2 put failed');
				await bucket.put(key, value);
			},
		};
		await expect(
			processFeedTarget({ bucket: failingBucket, fetcher: fetcher(), target: target() }),
		).rejects.toThrow('R2 put failed');
	});
});
