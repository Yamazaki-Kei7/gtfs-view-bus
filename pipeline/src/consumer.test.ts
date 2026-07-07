import { strToU8, zipSync } from 'fflate';
import { FIXTURE_FILES } from 'gtfs-core';
import { describe, expect, it } from 'vitest';
import { processFeedJobMessage } from './consumer';
import {
	CURRENT_JOB_KEY,
	type FeedJobMessage,
	type FeedJobStatus,
	jobManifestKey,
	jobStatusKey,
} from './jobState';
import type { BucketLike } from './storage';

function fakeBucket(): BucketLike & { store: Map<string, string> } {
	const store = new Map<string, string>();
	return {
		store,
		async get(key: string) {
			const value = store.get(key);
			return value === undefined ? null : { text: async () => value };
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
		async list({ prefix }: { prefix: string }) {
			return {
				objects: [...store.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
				truncated: false,
			};
		},
		async delete(keys: string[]) {
			for (const key of keys) store.delete(key);
		},
	};
}

const FIXTURE_ZIP = zipSync(
	Object.fromEntries(Object.entries(FIXTURE_FILES).map(([key, value]) => [key, strToU8(value)])),
);

function message(zipUrl = 'https://example.com/feed.zip'): FeedJobMessage {
	return {
		jobId: 'job-1',
		target: {
			id: 'feed-1',
			name: 'feed-1',
			orgName: 'org',
			license: null,
			fromDate: '',
			toDate: '',
			source: 'gtfs-data.jp',
			versionId: 'v1',
			zipUrl,
		},
	};
}

function fetcher(): typeof fetch {
	const impl = async (input: RequestInfo | URL): Promise<Response> => {
		const url = String(input);
		if (url.endsWith('feed.zip')) return new Response(FIXTURE_ZIP);
		return new Response('not found', { status: 404 });
	};
	return impl as typeof fetch;
}

function saveManifest(bucket: ReturnType<typeof fakeBucket>, body: FeedJobMessage): void {
	bucket.store.set(
		jobManifestKey(body.jobId),
		JSON.stringify({
			jobId: body.jobId,
			createdAt: '2026-07-07T12:00:00.000Z',
			targets: [body.target],
			sources: { 'gtfs-data.jp': 1, odpt: 0 },
			previousFeedsGeneratedAt: null,
		}),
	);
}

describe('processFeedJobMessage', () => {
	it('フィード処理結果をstatusへ保存してfinalizeする', async () => {
		const bucket = fakeBucket();
		const body = message();
		saveManifest(bucket, body);

		await processFeedJobMessage({
			bucket,
			fetcher: fetcher(),
			message: body,
			now: () => new Date('2026-07-07T12:01:00.000Z'),
		});

		const saved = JSON.parse(bucket.store.get(jobStatusKey('job-1', 'feed-1')) ?? '{}') as FeedJobStatus;
		expect(saved.jobId).toBe('job-1');
		expect(saved.finishedAt).toBe('2026-07-07T12:01:00.000Z');
		expect(saved.status).toBe('updated');
		expect(JSON.parse(bucket.store.get(CURRENT_JOB_KEY) ?? '{}')).toMatchObject({
			jobId: 'job-1',
			status: 'completed',
			total: 1,
			completed: 1,
		});
	});

	it('通常のフィード処理失敗もerror statusとして保存してfinalizeする', async () => {
		const bucket = fakeBucket();
		const body = message('https://example.com/missing.zip');
		saveManifest(bucket, body);

		await processFeedJobMessage({
			bucket,
			fetcher: fetcher(),
			message: body,
			now: () => new Date('2026-07-07T12:02:00.000Z'),
		});

		const saved = JSON.parse(bucket.store.get(jobStatusKey('job-1', 'feed-1')) ?? '{}') as FeedJobStatus;
		expect(saved).toMatchObject({
			jobId: 'job-1',
			finishedAt: '2026-07-07T12:02:00.000Z',
			status: 'error',
			error: 'zip fetch failed: 404',
		});
		const index = JSON.parse(bucket.store.get('feeds.json') ?? '{}') as {
			feeds: { id: string; status: string; error?: string }[];
		};
		expect(index.feeds).toEqual([
			expect.objectContaining({
				id: 'feed-1',
				status: 'error',
				error: 'zip fetch failed: 404',
			}),
		]);
	});

	it('manifestを読めない場合はstatus保存後にthrowする', async () => {
		const bucket = fakeBucket();
		const body = message();

		await expect(
			processFeedJobMessage({
				bucket,
				fetcher: fetcher(),
				message: body,
				now: () => new Date('2026-07-07T12:03:00.000Z'),
			}),
		).rejects.toThrow('job manifest not found: job-1');
		expect(bucket.store.has(jobStatusKey('job-1', 'feed-1'))).toBe(true);
		expect(bucket.store.has('feeds.json')).toBe(false);
	});

	it('既存statusがある再試行ではフィード処理を再実行せずfinalizeだけ行う', async () => {
		const bucket = fakeBucket();
		const body = message();
		saveManifest(bucket, body);
		const savedStatus: FeedJobStatus = {
			jobId: 'job-1',
			finishedAt: '2026-07-07T12:01:00.000Z',
			id: body.target.id,
			name: body.target.name,
			orgName: body.target.orgName,
			license: body.target.license,
			fromDate: body.target.fromDate,
			toDate: body.target.toDate,
			source: body.target.source,
			status: 'updated',
			shapeSourceCounts: { shapes: 1, route: 0, straight: 0 },
		};
		bucket.store.set(jobStatusKey('job-1', 'feed-1'), JSON.stringify(savedStatus));
		const impl = async (): Promise<Response> => {
			throw new Error('fetch should not run on status retry');
		};

		await processFeedJobMessage({
			bucket,
			fetcher: impl as typeof fetch,
			message: body,
			now: () => new Date('2026-07-07T12:05:00.000Z'),
		});

		const saved = JSON.parse(bucket.store.get(jobStatusKey('job-1', 'feed-1')) ?? '{}') as FeedJobStatus;
		expect(saved).toEqual(savedStatus);
		const index = JSON.parse(bucket.store.get('feeds.json') ?? '{}') as {
			feeds: { id: string; status: string }[];
		};
		expect(index.feeds).toEqual([expect.objectContaining({ id: 'feed-1', status: 'updated' })]);
	});
});
