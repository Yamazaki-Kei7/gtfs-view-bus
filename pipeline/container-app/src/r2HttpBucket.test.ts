import { describe, expect, it } from 'vitest';
import { createR2HttpBucket } from './r2HttpBucket';

function recordingFetcher(
	responses: Map<string, Response>,
	calls: { url: string; method: string; body?: string }[],
): typeof fetch {
	const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = String(input);
		const method = init?.method ?? 'GET';
		const body = typeof init?.body === 'string' ? init.body : undefined;
		calls.push({ url, method, body });
		return responses.get(`${method} ${url}`) ?? new Response('not found', { status: 404 });
	};
	return impl as typeof fetch;
}

describe('createR2HttpBucket', () => {
	it('getはHTTP 200をtext付きobjectとして返す', async () => {
		const calls: { url: string; method: string }[] = [];
		const bucket = createR2HttpBucket({
			baseUrl: 'http://r2.internal',
			fetcher: recordingFetcher(
				new Map([[
					'GET http://r2.internal/feeds/feed-1/meta.json',
					new Response('{"ok":true}'),
				]]),
				calls,
			),
		});

		const object = await bucket.get('feeds/feed-1/meta.json');
		expect(object ? await object.text() : null).toBe('{"ok":true}');
		expect(calls).toEqual([{ url: 'http://r2.internal/feeds/feed-1/meta.json', method: 'GET' }]);
	});

	it('getはHTTP 404をnullとして返す', async () => {
		const calls: { url: string; method: string }[] = [];
		const bucket = createR2HttpBucket({
			baseUrl: 'http://r2.internal',
			fetcher: recordingFetcher(new Map(), calls),
		});

		await expect(bucket.get('feeds/feed-1/meta.json')).resolves.toBeNull();
	});

	it('putはHTTP PUTで文字列を書き込む', async () => {
		const calls: { url: string; method: string; body?: string }[] = [];
		const bucket = createR2HttpBucket({
			baseUrl: 'http://r2.internal',
			fetcher: recordingFetcher(
				new Map([[
					'PUT http://r2.internal/feeds/feed-1/bundle.json',
					new Response(null, { status: 204 }),
				]]),
				calls,
			),
		});

		await bucket.put('feeds/feed-1/bundle.json', '{"ok":true}');
		expect(calls).toEqual([
			{
				url: 'http://r2.internal/feeds/feed-1/bundle.json',
				method: 'PUT',
				body: '{"ok":true}',
			},
		]);
	});

	it('put失敗はthrowする', async () => {
		const calls: { url: string; method: string }[] = [];
		const bucket = createR2HttpBucket({
			baseUrl: 'http://r2.internal',
			fetcher: recordingFetcher(
				new Map([[
					'PUT http://r2.internal/feeds/feed-1/bundle.json',
					new Response('bad', { status: 500 }),
				]]),
				calls,
			),
		});

		await expect(bucket.put('feeds/feed-1/bundle.json', '{}')).rejects.toThrow(
			'R2 outbound put failed: 500 feeds/feed-1/bundle.json',
		);
	});
});
