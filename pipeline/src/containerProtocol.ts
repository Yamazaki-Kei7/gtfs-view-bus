import type { FeedJobMessage, FeedStatus } from './jobState';
import type { SourceId } from './sources/types';

export const CONTAINER_PROCESS_PATH = '/process-feed';
export const CONTAINER_PROCESS_TIMEOUT_MS = 14 * 60 * 1000;

export interface ProcessFeedRequest extends FeedJobMessage {
	odptConsumerKey?: string;
}

export type ProcessFeedResponse = FeedStatus;

export function containerInstanceName(jobId: string, feedId: string): string {
	return `feed-${jobId}-${encodeURIComponent(feedId)}`;
}

function isSourceId(value: string | undefined): value is SourceId {
	return value === 'gtfs-data.jp' || value === 'odpt';
}

function isStatus(value: string | undefined): value is FeedStatus['status'] {
	return value === 'updated' || value === 'unchanged' || value === 'error';
}

function shapeSourceCounts(value: Partial<FeedStatus>): Record<string, number> | undefined {
	const counts = value.shapeSourceCounts;
	if (counts === undefined) return undefined;
	if (counts === null || Array.isArray(counts) || typeof counts !== 'object') {
		throw new Error('container status response malformed: shapeSourceCounts');
	}
	for (const [key, count] of Object.entries(counts)) {
		if (typeof key !== 'string' || typeof count !== 'number') {
			throw new Error('container status response malformed: shapeSourceCounts');
		}
	}
	return counts;
}

export function parseFeedStatusResponse(text: string): ProcessFeedResponse {
	const parsed = JSON.parse(text) as Partial<FeedStatus>;
	if (typeof parsed.id !== 'string') throw new Error('container status response malformed: id');
	if (typeof parsed.name !== 'string') throw new Error('container status response malformed: name');
	if (typeof parsed.orgName !== 'string') {
		throw new Error('container status response malformed: orgName');
	}
	if (!(typeof parsed.license === 'string' || parsed.license === null)) {
		throw new Error('container status response malformed: license');
	}
	if (typeof parsed.fromDate !== 'string') {
		throw new Error('container status response malformed: fromDate');
	}
	if (typeof parsed.toDate !== 'string') {
		throw new Error('container status response malformed: toDate');
	}
	if (!isSourceId(parsed.source)) throw new Error('container status response malformed: source');
	if (!isStatus(parsed.status)) throw new Error('container status response malformed: status');
	if (
		parsed.prefId !== undefined &&
		parsed.prefId !== null &&
		(typeof parsed.prefId !== 'number' || !Number.isInteger(parsed.prefId))
	) {
		throw new Error('container status response malformed: prefId');
	}
	if (parsed.error !== undefined && typeof parsed.error !== 'string') {
		throw new Error('container status response malformed: error');
	}
	return {
		id: parsed.id,
		name: parsed.name,
		orgName: parsed.orgName,
		license: parsed.license,
		fromDate: parsed.fromDate,
		toDate: parsed.toDate,
		source: parsed.source,
		prefId: parsed.prefId,
		status: parsed.status,
		error: parsed.error,
		shapeSourceCounts: shapeSourceCounts(parsed),
	};
}
