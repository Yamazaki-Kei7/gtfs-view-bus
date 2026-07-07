/// <reference path="../worker-configuration.d.ts" />

import { processFeedJobMessage } from './consumer';
import { createFeedJob } from './jobProducer';
import type { FeedJobMessage } from './jobState';
import { toBucketLike } from './storage';
import { createGtfsDataJpSource } from './sources/gtfsDataJp';
import { createOdptSource } from './sources/odpt';

function randomBytes(): Uint8Array {
	const bytes = new Uint8Array(3);
	crypto.getRandomValues(bytes);
	return bytes;
}

export default {
	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(
			createFeedJob({
				bucket: toBucketLike(env.DATA_BUCKET),
				queue: {
					sendBatch: async (messages) => {
						await env.FEED_QUEUE.sendBatch(messages);
					},
				},
				fetcher: fetch,
				sources: [createGtfsDataJpSource(), createOdptSource()],
				now: () => new Date(),
				randomBytes,
			}),
		);
	},
	async queue(batch: MessageBatch<FeedJobMessage>, env: Env): Promise<void> {
		const bucket = toBucketLike(env.DATA_BUCKET);
		for (const message of batch.messages) {
			try {
				await processFeedJobMessage({
					bucket,
					fetcher: fetch,
					message: message.body,
					now: () => new Date(),
				});
				message.ack();
			} catch (error) {
				console.error(
					JSON.stringify({
						event: 'feed_job_message_failed',
						messageId: message.id,
						attempts: message.attempts,
						error: error instanceof Error ? error.message : String(error),
					}),
				);
				message.retry();
			}
		}
	},
} satisfies ExportedHandler<Env, FeedJobMessage>;
