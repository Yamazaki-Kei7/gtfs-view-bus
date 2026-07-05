import type { BucketLike } from './run';
import { runPipeline } from './run';

interface Env {
	DATA_BUCKET: R2Bucket;
	GTFS_PREF_ID: string;
}

/** R2Bucket.put() は R2Object を返すが BucketLike は void を期待するため薄くラップする */
function toBucketLike(bucket: R2Bucket): BucketLike {
	return {
		get: (key) => bucket.get(key),
		put: async (key, value) => {
			await bucket.put(key, value);
		},
	};
}

export default {
	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(
			runPipeline({
				bucket: toBucketLike(env.DATA_BUCKET),
				fetcher: fetch,
				prefId: env.GTFS_PREF_ID,
			}),
		);
	},
} satisfies ExportedHandler<Env>;
