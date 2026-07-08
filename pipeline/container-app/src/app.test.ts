import { strToU8, zipSync } from 'fflate';
import { FIXTURE_FILES, FIXTURE_ROUTES_GEOJSON } from 'gtfs-core';
import { describe, expect, it } from 'vitest';
import { handleContainerRequest } from './app';

const FIXTURE_ZIP = zipSync(
	Object.fromEntries(Object.entries(FIXTURE_FILES).map(([key, value]) => [key, strToU8(value)])),
);

function fetcher(store: Map<string, string>, calls: string[]): typeof fetch {
	const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = String(input);
		calls.push(url);
		if (url === 'https://example.com/feed.zip') return new Response(FIXTURE_ZIP);
		if (url === 'https://example.com/routes.geojson') return new Response(FIXTURE_ROUTES_GEOJSON);
		if (url.startsWith('http://r2.internal/')) {
			const key = decodeURIComponent(new URL(url).pathname.slice(1));
			if (init?.method === 'PUT') {
				store.set(key, typeof init.body === 'string' ? init.body : '');
				return new Response(null, { status: 204 });
			}
			const value = store.get(key);
			return value === undefined ? new Response('not found', { status: 404 }) : new Response(value);
		}
		return new Response('not found', { status: 404 });
	};
	return impl as typeof fetch;
}

function processRequest(): Request {
	return new Request('http://container/process-feed', {
		method: 'POST',
		body: JSON.stringify({
			jobId: 'job-1',
			target: {
				id: 'feed-1',
				name: 'フィード1',
				orgName: '事業者',
				license: null,
				fromDate: '2026-04-01',
				toDate: '2027-03-31',
				source: 'gtfs-data.jp',
				versionId: 'v1',
				zipUrl: 'https://example.com/feed.zip',
				routesGeojsonUrl: 'https://example.com/routes.geojson',
				prefId: 10,
			},
			odptConsumerKey: 'SECRET',
		}),
	});
}

function failingPutFetcher(store: Map<string, string>, calls: string[]): typeof fetch {
	const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = String(input);
		calls.push(url);
		if (url === 'https://example.com/feed.zip') return new Response(FIXTURE_ZIP);
		if (url === 'https://example.com/routes.geojson') return new Response(FIXTURE_ROUTES_GEOJSON);
		if (url.startsWith('http://r2.internal/')) {
			const key = decodeURIComponent(new URL(url).pathname.slice(1));
			if (init?.method === 'PUT') {
				if (key === 'feeds/feed-1/bundle.json') {
					return new Response('bad', { status: 500 });
				}
				store.set(key, typeof init?.body === 'string' ? init.body : '');
				return new Response(null, { status: 204 });
			}
			const value = store.get(key);
			return value === undefined ? new Response('not found', { status: 404 }) : new Response(value);
		}
		return new Response('not found', { status: 404 });
	};
	return impl as typeof fetch;
}

describe('handleContainerRequest', () => {
	it('POST /process-feedでGTFSを変換してR2へ成果物を書く', async () => {
		const store = new Map<string, string>();
		const calls: string[] = [];

		const res = await handleContainerRequest(
			processRequest(),
			{ R2_BASE_URL: 'http://r2.internal' },
			fetcher(store, calls),
		);

		expect(res.status).toBe(200);
		const status = (await res.json()) as { status?: string; prefId?: number | null };
		expect(status.status).toBe('updated');
		expect(status.prefId).toBe(10);
		expect(store.has('feeds/feed-1/bundle.json')).toBe(true);
		expect(store.has('feeds/feed-1/routes.geojson')).toBe(true);
		expect(store.has('feeds/feed-1/stops.geojson')).toBe(true);
		expect(store.has('feeds/feed-1/timetable.json')).toBe(true);
		expect(store.has('feeds/feed-1/meta.json')).toBe(true);
	});

	it('GETは405を返す', async () => {
		const res = await handleContainerRequest(
			new Request('http://container/process-feed'),
			{ R2_BASE_URL: 'http://r2.internal' },
			fetcher(new Map(), []),
		);
		expect(res.status).toBe(405);
	});

	it('R2保存失敗時はstatus:errorとしてFeedStatusを返す', async () => {
		const store = new Map<string, string>();
		const calls: string[] = [];

		const res = await handleContainerRequest(
			processRequest(),
			{ R2_BASE_URL: 'http://r2.internal' },
			failingPutFetcher(store, calls),
		);

		const status = (await res.json()) as {
			id: string;
			name: string;
			orgName: string;
			license: string | null;
			fromDate: string;
			toDate: string;
			source: string;
			prefId: number | null;
			status: string;
			error?: string;
		};

		expect(res.status).toBe(200);
		expect(status).toMatchObject({
			id: 'feed-1',
			name: 'フィード1',
			orgName: '事業者',
			license: null,
			fromDate: '2026-04-01',
			toDate: '2027-03-31',
			source: 'gtfs-data.jp',
			prefId: 10,
			status: 'error',
		});
		expect(status.error).toContain('R2 outbound put failed');
	});

	it('不正JSONは400を返す', async () => {
		const res = await handleContainerRequest(
			new Request('http://container/process-feed', { method: 'POST', body: '{' }),
			{ R2_BASE_URL: 'http://r2.internal' },
			fetcher(new Map(), []),
		);
		expect(res.status).toBe(400);
	});
});
