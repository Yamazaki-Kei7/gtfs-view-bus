import type { BucketLike } from './run';
import { runPipeline } from './run';
import { createGtfsDataJpSource } from './sources/gtfsDataJp';
import { createOdptSource } from './sources/odpt';

interface Env {
	DATA_BUCKET: R2Bucket;
	GTFS_PREF_ID: string;
}

/** R2Bucket の戻り値型を BucketLike の期待へ薄くラップする */
function toBucketLike(bucket: R2Bucket): BucketLike {
	return {
		get: (key) => bucket.get(key),
		put: async (key, value) => {
			await bucket.put(key, value);
		},
		list: async (options) => {
			const res = await bucket.list({ prefix: options.prefix, cursor: options.cursor });
			return {
				objects: res.objects.map((o) => ({ key: o.key })),
				truncated: res.truncated,
				cursor: res.truncated ? res.cursor : undefined,
			};
		},
		delete: async (keys) => {
			await bucket.delete(keys);
		},
	};
}

export default {
	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		const prefIds = env.GTFS_PREF_ID.split(',')
			.map((v) => v.trim())
			.filter(Boolean)
			.map((v) => Number(v))
			.filter((id) => Number.isInteger(id) && id > 0);
		ctx.waitUntil(
			runPipeline({
				bucket: toBucketLike(env.DATA_BUCKET),
				fetcher: fetch,
				sources: [createGtfsDataJpSource(prefIds.length === 0 ? {} : { prefIds }), createOdptSource()],
			}),
		);
	},
} satisfies ExportedHandler<Env>;
