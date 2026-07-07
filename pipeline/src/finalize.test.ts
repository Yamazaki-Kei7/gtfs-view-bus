import { describe, expect, it } from 'vitest';
import {
	CURRENT_JOB_KEY,
	type FeedJobStatus,
	type JobManifest,
	type JobSummary,
	jobManifestKey,
	jobStatusKey,
	jobSummaryKey,
} from './jobState';
import { maybeFinalizeJob, writeFeedStatus } from './finalize';
import type { BucketLike } from './storage';
import type { FeedTarget } from './sources/types';

function fakeBucket(): BucketLike & { store: Map<string, string>; deleted: string[] } {
	const store = new Map<string, string>();
	const deleted: string[] = [];
	return {
		store,
		deleted,
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
			deleted.push(...keys);
			for (const key of keys) store.delete(key);
		},
	};
}

function target(id: string, source: 'gtfs-data.jp' | 'odpt'): FeedTarget {
	return {
		id,
		name: id,
		orgName: 'org',
		license: null,
		fromDate: '',
		toDate: '',
		source,
		versionId: `v-${id}`,
		zipUrl: `https://example.com/${id}.zip`,
	};
}

function status(t: FeedTarget, value: 'updated' | 'unchanged' | 'error'): FeedJobStatus {
	return {
		jobId: 'job-1',
		finishedAt: '2026-07-07T12:01:00.000Z',
		id: t.id,
		name: t.name,
		orgName: t.orgName,
		license: t.license,
		fromDate: t.fromDate,
		toDate: t.toDate,
		source: t.source,
		status: value,
		error: value === 'error' ? 'broken feed' : undefined,
		shapeSourceCounts: value === 'updated' ? { shapes: 1, route: 0, straight: 0 } : undefined,
	};
}

describe('maybeFinalizeJob', () => {
	it('feed statusをjob別キーへ保存する', async () => {
		const bucket = fakeBucket();
		const t = target('a', 'gtfs-data.jp');

		await writeFeedStatus({ bucket, status: status(t, 'updated') });

		const saved = JSON.parse(bucket.store.get(jobStatusKey('job-1', 'a')) ?? '{}') as FeedJobStatus;
		expect(saved.status).toBe('updated');
		expect(saved.id).toBe('a');
	});

	it('全statusが揃うまで公開ファイルを書かない', async () => {
		const bucket = fakeBucket();
		const targets = [target('a', 'gtfs-data.jp'), target('b', 'odpt')];
		const manifest: JobManifest = {
			jobId: 'job-1',
			createdAt: '2026-07-07T12:00:00.000Z',
			targets,
			sources: { 'gtfs-data.jp': 1, odpt: 1 },
			previousFeedsGeneratedAt: null,
		};
		bucket.store.set(jobManifestKey('job-1'), JSON.stringify(manifest));
		bucket.store.set(jobStatusKey('job-1', 'a'), JSON.stringify(status(targets[0], 'updated')));

		const result = await maybeFinalizeJob({ bucket, jobId: 'job-1' });

		expect(result).toEqual({ finalized: false, missing: 1 });
		expect(bucket.store.has('feeds.json')).toBe(false);
		expect(bucket.store.has(jobSummaryKey('job-1'))).toBe(false);
		expect(bucket.store.has(CURRENT_JOB_KEY)).toBe(false);
		expect(bucket.deleted).toHaveLength(0);
	});

	it('全status完了時だけfeeds.json/summary/currentを書き、孤児掃除する', async () => {
		const bucket = fakeBucket();
		const targets = [target('a', 'gtfs-data.jp'), target('b', 'odpt')];
		const manifest: JobManifest = {
			jobId: 'job-1',
			createdAt: '2026-07-07T12:00:00.000Z',
			targets,
			sources: { 'gtfs-data.jp': 1, odpt: 1 },
			previousFeedsGeneratedAt: '2026-06-01T00:00:00.000Z',
		};
		bucket.store.set(jobManifestKey('job-1'), JSON.stringify(manifest));
		bucket.store.set(jobStatusKey('job-1', 'a'), JSON.stringify(status(targets[0], 'updated')));
		bucket.store.set(jobStatusKey('job-1', 'b'), JSON.stringify(status(targets[1], 'error')));
		bucket.store.set('feeds/orphan/bundle.json', '{}');
		bucket.store.set('feeds/a/bundle.json', '{}');

		const result = await maybeFinalizeJob({ bucket, jobId: 'job-1' });

		expect(result).toEqual({ finalized: true, missing: 0 });
		const index = JSON.parse(bucket.store.get('feeds.json') ?? '{}') as {
			generatedAt?: string;
			feeds: { id: string; shapeSourceCounts?: Record<string, number> }[];
		};
		expect(index.generatedAt).toBe('2026-07-07T12:00:00.000Z');
		expect(index.feeds.map((feed) => feed.id)).toEqual(['a', 'b']);
		expect(index.feeds[0].shapeSourceCounts).toEqual({ shapes: 1, route: 0, straight: 0 });
		const summary = JSON.parse(bucket.store.get(jobSummaryKey('job-1')) ?? '{}') as JobSummary;
		expect(summary).toEqual({
			jobId: 'job-1',
			generatedAt: '2026-07-07T12:00:00.000Z',
			total: 2,
			updated: 1,
			unchanged: 0,
			error: 1,
			sources: { 'gtfs-data.jp': 1, odpt: 1 },
			published: true,
		});
		expect(JSON.parse(bucket.store.get(CURRENT_JOB_KEY) ?? '{}')).toMatchObject({
			jobId: 'job-1',
			status: 'completed',
			total: 2,
			completed: 2,
		});
		expect(bucket.deleted).toEqual(['feeds/orphan/bundle.json']);
	});

	it('manifestが無い場合は呼び出し側へthrowする', async () => {
		await expect(maybeFinalizeJob({ bucket: fakeBucket(), jobId: 'missing-job' })).rejects.toThrow(
			'job manifest not found: missing-job',
		);
	});
});
