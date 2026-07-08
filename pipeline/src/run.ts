import { processFeedTarget } from './feedProcessor';
import type { FeedStatus } from './jobState';
import type { BucketLike } from './storage';
import { putJson } from './storage';
import type { FeedSource, FeedTarget } from './sources/types';

export type { BucketLike } from './storage';

export interface PipelineDeps {
	bucket: BucketLike;
	fetcher: typeof fetch;
	sources: FeedSource[];
}

/** R2の一括deleteは1回1000キーまで */
const DELETE_BATCH = 1000;

export async function runPipeline({
	bucket,
	fetcher,
	sources,
}: PipelineDeps): Promise<FeedStatus[]> {
	const targets: FeedTarget[] = [];
	for (const source of sources) {
		targets.push(...(await source.listTargets(fetcher)));
	}

	const statuses: FeedStatus[] = [];
	for (const target of targets) {
		statuses.push(await processFeedTarget({ bucket, fetcher, target }));
	}

	await putJson(bucket, 'feeds.json', { generatedAt: new Date().toISOString(), feeds: statuses });
	await cleanupOrphans(bucket, new Set(targets.map((target) => target.id)));
	return statuses;
}

/** アクティブなフィードIDに属さない feeds/ 配下のキーを削除する */
export async function cleanupOrphans(bucket: BucketLike, activeIds: Set<string>): Promise<void> {
	const orphans: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix: 'feeds/', cursor });
		for (const obj of page.objects) {
			const feedId = obj.key.split('/')[1];
			if (feedId && !activeIds.has(feedId)) orphans.push(obj.key);
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);

	for (let i = 0; i < orphans.length; i += DELETE_BATCH) {
		await bucket.delete(orphans.slice(i, i + DELETE_BATCH));
	}
}
