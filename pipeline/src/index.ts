/// <reference path="../worker-configuration.d.ts" />

import { processFeedJobMessage } from './consumer';
import { createContainerResolver, dispatchFeedToContainer } from './containerDispatcher';
import { createFeedJob } from './jobProducer';
import type { FeedJobMessage } from './jobState';
import { toBucketLike } from './storage';
import { createGtfsDataJpSource } from './sources/gtfsDataJp';
import { createOdptSource, withOdptConsumerKey } from './sources/odpt';
export { FeedProcessorContainer } from './container';

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
				fetcher: withOdptConsumerKey(fetch, env.ODPT_CONSUMER_KEY),
				sources: [
					createGtfsDataJpSource(),
					createOdptSource(undefined, { includeKeyRequired: Boolean(env.ODPT_CONSUMER_KEY) }),
				],
				now: () => new Date(),
				randomBytes,
			}),
		);
	},
	async queue(batch: MessageBatch<FeedJobMessage>, env: Env): Promise<void> {
		const bucket = toBucketLike(env.DATA_BUCKET);
		const resolver = createContainerResolver(env.FEED_PROCESSOR_CONTAINER);
		for (const message of batch.messages) {
			try {
				await processFeedJobMessage({
					bucket,
					processor: {
						process: async (body) =>
							dispatchFeedToContainer({
								resolver,
								message: body,
								odptConsumerKey: env.ODPT_CONSUMER_KEY,
							}),
					},
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
