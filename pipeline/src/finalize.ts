import { cleanupOrphans } from './run';
import {
	CURRENT_JOB_KEY,
	type FeedJobStatus,
	type FeedStatus,
	type JobCurrent,
	type JobManifest,
	type JobSummary,
	jobManifestKey,
	jobStatusKey,
	jobSummaryKey,
} from './jobState';
import type { BucketLike } from './storage';
import { putJson, readJson } from './storage';

export interface WriteFeedStatusDeps {
	bucket: BucketLike;
	status: FeedJobStatus;
}

export interface MaybeFinalizeDeps {
	bucket: BucketLike;
	jobId: string;
}

export interface MaybeFinalizeResult {
	finalized: boolean;
	missing: number;
}

export async function writeFeedStatus({ bucket, status }: WriteFeedStatusDeps): Promise<void> {
	await putJson(bucket, jobStatusKey(status.jobId, status.id), status);
}

function toPublicStatus(status: FeedJobStatus): FeedStatus {
	const publicStatus: FeedStatus = {
		id: status.id,
		name: status.name,
		orgName: status.orgName,
		license: status.license,
		fromDate: status.fromDate,
		toDate: status.toDate,
		source: status.source,
		status: status.status,
		error: status.error,
		shapeSourceCounts: status.shapeSourceCounts,
	};
	return publicStatus;
}

function buildSummary(manifest: JobManifest, statuses: FeedJobStatus[]): JobSummary {
	return {
		jobId: manifest.jobId,
		generatedAt: manifest.createdAt,
		total: statuses.length,
		updated: statuses.filter((status) => status.status === 'updated').length,
		unchanged: statuses.filter((status) => status.status === 'unchanged').length,
		error: statuses.filter((status) => status.status === 'error').length,
		sources: manifest.sources,
		published: true,
	};
}

export async function maybeFinalizeJob({
	bucket,
	jobId,
}: MaybeFinalizeDeps): Promise<MaybeFinalizeResult> {
	const manifest = await readJson<JobManifest>(bucket, jobManifestKey(jobId));
	if (!manifest) throw new Error(`job manifest not found: ${jobId}`);

	const statuses: FeedJobStatus[] = [];
	let missing = 0;
	for (const target of manifest.targets) {
		const status = await readJson<FeedJobStatus>(bucket, jobStatusKey(jobId, target.id));
		if (!status) {
			missing += 1;
			continue;
		}
		statuses.push(status);
	}

	if (missing > 0) return { finalized: false, missing };

	await putJson(bucket, 'feeds.json', {
		generatedAt: manifest.createdAt,
		feeds: statuses.map(toPublicStatus),
	});
	await putJson(bucket, jobSummaryKey(jobId), buildSummary(manifest, statuses));

	const current: JobCurrent = {
		jobId,
		status: 'completed',
		createdAt: manifest.createdAt,
		total: manifest.targets.length,
		completed: statuses.length,
	};
	await putJson(bucket, CURRENT_JOB_KEY, current);

	await cleanupOrphans(bucket, new Set(manifest.targets.map((target) => target.id)));

	return { finalized: true, missing: 0 };
}
