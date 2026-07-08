import { describe, expect, it } from 'vitest';
import { createR2OutboundHandler, isAllowedFeedArtifactKey } from './r2Outbound';

function fakeR2(): R2Bucket & { store: Map<string, string> } {
	const store = new Map<string, string>();
	return {
		store,
		get: async (key: string) => {
			const value = store.get(key);
			if (value === undefined) return null;

			const response = new Response(value);
			const text = async () => await response.clone().text();

			return {
				key,
				version: 'v0',
				size: value.length,
				etag: 'etag',
				httpEtag: '"etag"',
				checksums: { toJSON: () => ({}) },
				uploaded: new Date(0),
				storageClass: 'STANDARD',
				body: response.body as ReadableStream,
				bodyUsed: response.bodyUsed,
				arrayBuffer: async () => await response.clone().arrayBuffer(),
				bytes: async () => new Uint8Array(await response.clone().arrayBuffer()),
				text,
				json: async <T>() => JSON.parse(await text()) as T,
				blob: async () => await response.clone().blob(),
			};
		},
		put: async (key: string, value: string | ReadableStream | ArrayBuffer) => {
			store.set(key, typeof value === 'string' ? value : '');
			return null;
		},
	} as R2Bucket & { store: Map<string, string> };
}

describe('r2Outbound', () => {
	it('feeds配下の成果物キーだけ許可する', () => {
		expect(isAllowedFeedArtifactKey('feeds/feed-1/bundle.json')).toBe(true);
		expect(isAllowedFeedArtifactKey('feeds/feed-1/routes.geojson')).toBe(true);
		expect(isAllowedFeedArtifactKey('feeds/feed-1/stops.geojson')).toBe(true);
		expect(isAllowedFeedArtifactKey('feeds/feed-1/timetable.json')).toBe(true);
		expect(isAllowedFeedArtifactKey('feeds/feed-1/meta.json')).toBe(true);
		expect(isAllowedFeedArtifactKey('feeds/feed-1/other.json')).toBe(false);
		expect(isAllowedFeedArtifactKey('pipeline/jobs/job-1/status.json')).toBe(false);
	});

	it('PUTで許可キーへ書き込み、GETで読み戻す', async () => {
		const r2 = fakeR2();
		const handler = createR2OutboundHandler(r2);

		const put = await handler(
			new Request('http://r2.internal/feeds/feed-1/bundle.json', {
				method: 'PUT',
				body: '{"ok":true}',
			}),
		);
		expect(put.status).toBe(204);

		const get = await handler(new Request('http://r2.internal/feeds/feed-1/bundle.json'));
		expect(get.status).toBe(200);
		expect(await get.text()).toBe('{"ok":true}');
	});

	it('存在しないキーは404を返す', async () => {
		const handler = createR2OutboundHandler(fakeR2());
		const res = await handler(new Request('http://r2.internal/feeds/feed-1/meta.json'));
		expect(res.status).toBe(404);
	});

	it('許可されていないキーは403を返す', async () => {
		const handler = createR2OutboundHandler(fakeR2());
		const res = await handler(new Request('http://r2.internal/pipeline/jobs/current.json'));
		expect(res.status).toBe(403);
	});

	it('GETとPUT以外は405を返す', async () => {
		const handler = createR2OutboundHandler(fakeR2());
		const res = await handler(
			new Request('http://r2.internal/feeds/feed-1/meta.json', { method: 'DELETE' }),
		);
		expect(res.status).toBe(405);
	});
});
