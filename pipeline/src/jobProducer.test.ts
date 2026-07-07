import { describe, expect, it } from 'vitest';
import { createFeedJob, type QueueLike } from './jobProducer';
import type { FeedJobMessage, JobCurrent, JobManifest } from './jobState';
import type { BucketLike } from './storage';
import type { FeedSource, FeedTarget } from './sources/types';

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
		async list() {
			return { objects: [], truncated: false };
		},
		async delete() {},
	};
}

function fakeQueue(): QueueLike<FeedJobMessage> & { batches: { body: FeedJobMessage }[][] } {
	const batches: { body: FeedJobMessage }[][] = [];
	return {
		batches,
		async sendBatch(messages) {
			batches.push([...messages]);
		},
	};
}

function target(id: string, source: 'gtfs-data.jp' | 'odpt'): FeedTarget {
	return {
		id,
		name: id,
		orgName: 'org',
		license: 'CC BY 4.0',
		fromDate: '',
		toDate: '',
		source,
		versionId: `version-${id}`,
		zipUrl: `https://example.com/${id}.zip`,
	};
}

describe('createFeedJob', () => {
	it('manifest/currentを保存し、Queueへフィード単位メッセージを投入する', async () => {
		const bucket = fakeBucket();
		const queue = fakeQueue();
		const source: FeedSource = {
			sourceId: 'gtfs-data.jp',
			listTargets: async () => [target('a', 'gtfs-data.jp'), target('b', 'gtfs-data.jp')],
		};
		const result = await createFeedJob({
			bucket,
			queue,
			fetcher: fetch,
			sources: [source],
			now: () => new Date('2026-07-07T12:00:00.000Z'),
			randomBytes: () => new Uint8Array([0xa1, 0xb2, 0xc3]),
		});
		expect(result).toEqual({ status: 'queued', jobId: '20260707T120000Z-a1b2c3', total: 2 });
		const manifest = JSON.parse(
			bucket.store.get('pipeline/jobs/20260707T120000Z-a1b2c3/manifest.json') ?? '{}',
		) as JobManifest;
		expect(manifest.targets.map((t) => t.id)).toEqual(['a', 'b']);
		expect(manifest.sources).toEqual({ 'gtfs-data.jp': 2, odpt: 0 });
		const current = JSON.parse(bucket.store.get('pipeline/jobs/current.json') ?? '{}') as JobCurrent;
		expect(current.status).toBe('queued');
		expect(queue.batches).toHaveLength(1);
		expect(queue.batches[0].map((m) => m.body.target.id)).toEqual(['a', 'b']);
	});

	it('Queue投入を100件ずつ分割する', async () => {
		const bucket = fakeBucket();
		const queue = fakeQueue();
		const targets = Array.from({ length: 205 }, (_, i) => target(`feed-${i}`, 'gtfs-data.jp'));
		const source: FeedSource = { sourceId: 'gtfs-data.jp', listTargets: async () => targets };
		await createFeedJob({
			bucket,
			queue,
			fetcher: fetch,
			sources: [source],
			now: () => new Date('2026-07-07T12:00:00.000Z'),
			randomBytes: () => new Uint8Array([1, 2, 3]),
		});
		expect(queue.batches.map((batch) => batch.length)).toEqual([100, 100, 5]);
	});

	it('ソース一覧失敗時はfailed currentを書き、manifestとQueue投入を行わない', async () => {
		const bucket = fakeBucket();
		const queue = fakeQueue();
		const source: FeedSource = {
			sourceId: 'odpt',
			listTargets: () => Promise.reject(new Error('source down')),
		};
		const result = await createFeedJob({
			bucket,
			queue,
			fetcher: fetch,
			sources: [source],
			now: () => new Date('2026-07-07T12:00:00.000Z'),
			randomBytes: () => new Uint8Array([4, 5, 6]),
		});
		expect(result.status).toBe('failed');
		expect(bucket.store.has('pipeline/jobs/20260707T120000Z-040506/manifest.json')).toBe(false);
		const current = JSON.parse(bucket.store.get('pipeline/jobs/current.json') ?? '{}') as JobCurrent;
		expect(current.status).toBe('failed');
		expect(current.error).toBe('source down');
		expect(queue.batches).toHaveLength(0);
	});
});
