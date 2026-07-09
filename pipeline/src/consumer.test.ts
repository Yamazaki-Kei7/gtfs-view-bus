import { describe, expect, it } from 'vitest';
import { processFeedJobMessage, type FeedJobProcessor } from './consumer';
import {
	CURRENT_JOB_KEY,
	type FeedJobMessage,
	type FeedJobStatus,
	type FeedStatus,
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

function message(): FeedJobMessage {
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
			zipUrl: 'https://example.com/feed.zip',
		},
	};
}

function status(value: FeedStatus['status'], error?: string): FeedStatus {
	return {
		id: 'feed-1',
		name: 'feed-1',
		orgName: 'org',
		license: null,
		fromDate: '',
		toDate: '',
		source: 'gtfs-data.jp',
		status: value,
		error,
		shapeSourceCounts: value === 'updated' ? { shapes: 1, route: 0, straight: 0 } : undefined,
	};
}

function processor(result: FeedStatus, calls: FeedJobMessage[]): FeedJobProcessor {
	return {
		async process(body) {
			calls.push(body);
			return result;
		},
	};
}

function saveManifest(bucket: ReturnType<typeof fakeBucket>, body: FeedJobMessage): void {
	bucket.store.set(
		jobManifestKey(body.jobId),
		JSON.stringify({
			jobId: body.jobId,
			createdAt: '2026-07-07T12:00:00.000Z',
			targets: [body.target],
			sources: { 'gtfs-data.jp': 1, odpt: 0, hoda: 0 },
			previousFeedsGeneratedAt: null,
		}),
	);
}

describe('processFeedJobMessage', () => {
	it('フィード処理結果をstatusへ保存してfinalizeする', async () => {
		const bucket = fakeBucket();
		const body = message();
		saveManifest(bucket, body);
		const calls: FeedJobMessage[] = [];

		await processFeedJobMessage({
			bucket,
			processor: processor(status('updated'), calls),
			message: body,
			now: () => new Date('2026-07-07T12:01:00.000Z'),
		});

		const saved = JSON.parse(
			bucket.store.get(jobStatusKey('job-1', 'feed-1')) ?? '{}',
		) as FeedJobStatus;
		expect(saved.jobId).toBe('job-1');
		expect(saved.finishedAt).toBe('2026-07-07T12:01:00.000Z');
		expect(saved.status).toBe('updated');
		expect(calls).toEqual([body]);
		expect(JSON.parse(bucket.store.get(CURRENT_JOB_KEY) ?? '{}')).toMatchObject({
			jobId: 'job-1',
			status: 'completed',
			total: 1,
			completed: 1,
		});
	});

	it('通常のフィード処理失敗もerror statusとして保存してfinalizeする', async () => {
		const bucket = fakeBucket();
		const body = message();
		saveManifest(bucket, body);
		const calls: FeedJobMessage[] = [];

		await processFeedJobMessage({
			bucket,
			processor: processor(status('error', 'zip fetch failed: 404'), calls),
			message: body,
			now: () => new Date('2026-07-07T12:02:00.000Z'),
		});

		const saved = JSON.parse(
			bucket.store.get(jobStatusKey('job-1', 'feed-1')) ?? '{}',
		) as FeedJobStatus;
		expect(saved).toMatchObject({
			jobId: 'job-1',
			finishedAt: '2026-07-07T12:02:00.000Z',
			status: 'error',
			error: 'zip fetch failed: 404',
		});
		expect(calls).toEqual([body]);
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
		const calls: FeedJobMessage[] = [];

		await expect(
			processFeedJobMessage({
				bucket,
				processor: processor(status('updated'), calls),
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
		const failingProcessor: FeedJobProcessor = {
			async process() {
				throw new Error('processor should not run on status retry');
			},
		};

		await processFeedJobMessage({
			bucket,
			processor: failingProcessor,
			message: body,
			now: () => new Date('2026-07-07T12:05:00.000Z'),
		});

		const saved = JSON.parse(
			bucket.store.get(jobStatusKey('job-1', 'feed-1')) ?? '{}',
		) as FeedJobStatus;
		expect(saved).toEqual(savedStatus);
		const index = JSON.parse(bucket.store.get('feeds.json') ?? '{}') as {
			feeds: { id: string; status: string }[];
		};
		expect(index.feeds).toEqual([expect.objectContaining({ id: 'feed-1', status: 'updated' })]);
	});
});
