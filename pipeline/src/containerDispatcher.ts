import { getContainer } from '@cloudflare/containers';
import type { Container } from '@cloudflare/containers';
import {
	CONTAINER_PROCESS_PATH,
	CONTAINER_PROCESS_TIMEOUT_MS,
	containerInstanceName,
	parseFeedStatusResponse,
	type ProcessFeedRequest,
} from './containerProtocol';
import type { FeedJobMessage, FeedStatus } from './jobState';

export interface ContainerStubLike {
	fetch(request: Request): Promise<Response>;
}

export interface ContainerResolver {
	get(name: string): ContainerStubLike;
}

export interface DispatchFeedToContainerDeps {
	resolver: ContainerResolver;
	message: FeedJobMessage;
	odptConsumerKey?: string;
	timeoutMs?: number;
}

export function createContainerResolver(
	binding: DurableObjectNamespace<Container>,
): ContainerResolver {
	return {
		get(name) {
			return getContainer(binding, name);
		},
	};
}

export async function dispatchFeedToContainer({
	resolver,
	message,
	odptConsumerKey,
	timeoutMs = CONTAINER_PROCESS_TIMEOUT_MS,
}: DispatchFeedToContainerDeps): Promise<FeedStatus> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const container = resolver.get(containerInstanceName(message.jobId, message.target.id));
		const body: ProcessFeedRequest = { ...message, odptConsumerKey };
		const response = await container.fetch(
			new Request(`http://container${CONTAINER_PROCESS_PATH}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json; charset=utf-8' },
				body: JSON.stringify(body),
				signal: controller.signal,
			}),
		);
		if (!response.ok) throw new Error(`container process failed: ${response.status}`);
		return parseFeedStatusResponse(await response.text());
	} finally {
		clearTimeout(timeout);
	}
}
