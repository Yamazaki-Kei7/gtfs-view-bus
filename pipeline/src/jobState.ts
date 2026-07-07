import type { FeedTarget, SourceId } from './sources/types';

export interface FeedStatus {
	id: string;
	name: string;
	orgName: string;
	license: string | null;
	fromDate: string;
	toDate: string;
	source: SourceId;
	status: 'updated' | 'unchanged' | 'error';
	error?: string;
	shapeSourceCounts?: Record<string, number>;
}

export interface FeedJobMessage {
	jobId: string;
	target: FeedTarget;
}

export interface JobManifest {
	jobId: string;
	createdAt: string;
	targets: FeedTarget[];
	sources: Record<SourceId, number>;
	previousFeedsGeneratedAt: string | null;
}

export interface JobCurrent {
	jobId: string;
	status: 'queued' | 'failed' | 'completed';
	createdAt: string;
	total: number;
	completed: number;
	error?: string;
}

export interface FeedJobStatus extends FeedStatus {
	jobId: string;
	finishedAt: string;
}

export interface JobSummary {
	jobId: string;
	generatedAt: string;
	total: number;
	updated: number;
	unchanged: number;
	error: number;
	sources: Record<SourceId, number>;
	published: boolean;
}

export const CURRENT_JOB_KEY = 'pipeline/jobs/current.json';

export function jobManifestKey(jobId: string): string {
	return `pipeline/jobs/${jobId}/manifest.json`;
}

export function jobSummaryKey(jobId: string): string {
	return `pipeline/jobs/${jobId}/summary.json`;
}

export function encodedFeedId(feedId: string): string {
	return encodeURIComponent(feedId);
}

export function jobStatusKey(jobId: string, feedId: string): string {
	return `pipeline/jobs/${jobId}/statuses/${encodedFeedId(feedId)}.json`;
}
