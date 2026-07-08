import { maybeFinalizeJob, writeFeedStatus } from './finalize';
import { type FeedJobMessage, type FeedJobStatus, type FeedStatus, jobStatusKey } from './jobState';
import { readJson, type BucketLike } from './storage';

export interface FeedJobProcessor {
	process(message: FeedJobMessage): Promise<FeedStatus>;
}

export interface ProcessFeedJobMessageDeps {
	bucket: BucketLike;
	processor: FeedJobProcessor;
	message: FeedJobMessage;
	now(): Date;
}

export async function processFeedJobMessage({
	bucket,
	processor,
	message,
	now,
}: ProcessFeedJobMessageDeps): Promise<void> {
	const existingStatus = await readJson<FeedJobStatus>(
		bucket,
		jobStatusKey(message.jobId, message.target.id),
	);
	if (existingStatus) {
		await maybeFinalizeJob({ bucket, jobId: message.jobId });
		return;
	}

	const status = await processor.process(message);
	const jobStatus: FeedJobStatus = {
		...status,
		jobId: message.jobId,
		finishedAt: now().toISOString(),
	};

	await writeFeedStatus({ bucket, status: jobStatus });
	await maybeFinalizeJob({ bucket, jobId: message.jobId });
}
