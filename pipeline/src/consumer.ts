import { maybeFinalizeJob, writeFeedStatus } from './finalize';
import { processFeedTarget } from './feedProcessor';
import { type FeedJobMessage, type FeedJobStatus, jobStatusKey } from './jobState';
import { readJson, type BucketLike } from './storage';

export interface ProcessFeedJobMessageDeps {
	bucket: BucketLike;
	fetcher: typeof fetch;
	message: FeedJobMessage;
	now(): Date;
}

export async function processFeedJobMessage({
	bucket,
	fetcher,
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

	const status = await processFeedTarget({ bucket, fetcher, target: message.target });
	const jobStatus: FeedJobStatus = {
		...status,
		jobId: message.jobId,
		finishedAt: now().toISOString(),
	};

	await writeFeedStatus({ bucket, status: jobStatus });
	await maybeFinalizeJob({ bucket, jobId: message.jobId });
}
