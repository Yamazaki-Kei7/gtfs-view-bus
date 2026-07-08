import { describe, expect, it, vi } from 'vitest';
import { dispatchFeedToContainer } from './containerDispatcher';
import type { FeedJobMessage } from './jobState';

vi.mock('@cloudflare/containers', () => ({
	getContainer: vi.fn(),
}));

function message(): FeedJobMessage {
	return {
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
		},
	};
}

function resolver(response: Response, names: string[], requests: Request[]): { get(name: string): { fetch(request: Request): Promise<Response> } } {
	return {
		get(name) {
			names.push(name);
			return {
				async fetch(request) {
					requests.push(request);
					return response;
				},
			};
		},
	};
}

describe('dispatchFeedToContainer', () => {
	it('ContainerへFeedJobMessageをPOSTし、FeedStatusを返す', async () => {
		const names: string[] = [];
		const requests: Request[] = [];
		const status = await dispatchFeedToContainer({
			resolver: resolver(
				new Response(
					JSON.stringify({
						id: 'feed-1',
						name: 'フィード1',
						orgName: '事業者',
						license: null,
						fromDate: '2026-04-01',
						toDate: '2027-03-31',
						source: 'gtfs-data.jp',
						status: 'updated',
					}),
				),
				names,
				requests,
			),
			message: message(),
			odptConsumerKey: 'SECRET',
			timeoutMs: 1000,
		});

		expect(names).toEqual(['feed-job-1-feed-1']);
		expect(requests[0].method).toBe('POST');
		expect(new URL(requests[0].url).pathname).toBe('/process-feed');
		expect(await requests[0].text()).toBe(
			JSON.stringify({ ...message(), odptConsumerKey: 'SECRET' }),
		);
		expect(status.status).toBe('updated');
	});

	it('Container HTTPエラーはthrowする', async () => {
		await expect(
			dispatchFeedToContainer({
				resolver: resolver(new Response('broken', { status: 500 }), [], []),
				message: message(),
				timeoutMs: 1000,
			}),
		).rejects.toThrow('container process failed: 500');
	});

	it('ContainerレスポンスのJSONが不正ならthrowする', async () => {
		await expect(
			dispatchFeedToContainer({
				resolver: resolver(new Response('{'), [], []),
				message: message(),
				timeoutMs: 1000,
			}),
		).rejects.toThrow();
	});
});
