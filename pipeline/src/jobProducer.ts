import {
	CURRENT_JOB_KEY,
	jobManifestKey,
	type FeedJobMessage,
	type JobCurrent,
	type JobManifest,
} from './jobState';
import { putJson, readJson, type BucketLike } from './storage';
import type { FeedSource, FeedTarget, SourceId } from './sources/types';

export interface QueueMessageSend<T> {
	body: T;
}

export interface QueueLike<T> {
	sendBatch(messages: QueueMessageSend<T>[]): Promise<void>;
}

export interface CreateFeedJobDeps {
	bucket: BucketLike;
	queue: QueueLike<FeedJobMessage>;
	fetcher: typeof fetch;
	sources: FeedSource[];
	now(): Date;
	randomBytes(): Uint8Array;
}

export type CreateFeedJobResult =
	| { status: 'queued'; jobId: string; total: number }
	| { status: 'failed'; jobId: string; error: string };

const QUEUE_SEND_BATCH_SIZE = 100;

function jobTimestamp(now: Date): string {
	return now
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d{3}Z$/, 'Z');
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function createJobId(now: Date, randomBytes: Uint8Array): string {
	return `${jobTimestamp(now)}-${hex(randomBytes.slice(0, 3))}`;
}

async function collectTargets(
	sources: FeedSource[],
	fetcher: typeof fetch,
): Promise<{ targets: FeedTarget[]; counts: Record<SourceId, number> }> {
	const targets: FeedTarget[] = [];
	const counts: Record<SourceId, number> = { 'gtfs-data.jp': 0, odpt: 0, hoda: 0 };
	for (const source of sources) {
		const sourceTargets = await source.listTargets(fetcher);
		targets.push(...sourceTargets);
		counts[source.sourceId] += sourceTargets.length;
	}
	return { targets, counts };
}

export async function createFeedJob(deps: CreateFeedJobDeps): Promise<CreateFeedJobResult> {
	const createdAt = deps.now().toISOString();
	const jobId = createJobId(new Date(createdAt), deps.randomBytes());
	try {
		const { targets, counts } = await collectTargets(deps.sources, deps.fetcher);
		const prev = await readJson<{ generatedAt: string }>(deps.bucket, 'feeds.json');
		const manifest: JobManifest = {
			jobId,
			createdAt,
			targets,
			sources: counts,
			previousFeedsGeneratedAt: prev?.generatedAt ?? null,
		};
		await putJson(deps.bucket, jobManifestKey(jobId), manifest);
		const current: JobCurrent = {
			jobId,
			status: 'queued',
			createdAt,
			total: targets.length,
			completed: 0,
		};
		await putJson(deps.bucket, CURRENT_JOB_KEY, current);
		const messages = targets.map((target): QueueMessageSend<FeedJobMessage> => ({
			body: { jobId, target },
		}));
		for (let i = 0; i < messages.length; i += QUEUE_SEND_BATCH_SIZE) {
			await deps.queue.sendBatch(messages.slice(i, i + QUEUE_SEND_BATCH_SIZE));
		}
		return { status: 'queued', jobId, total: targets.length };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const current: JobCurrent = {
			jobId,
			status: 'failed',
			createdAt,
			total: 0,
			completed: 0,
			error: message,
		};
		await putJson(deps.bucket, CURRENT_JOB_KEY, current);
		return { status: 'failed', jobId, error: message };
	}
}
