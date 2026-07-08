import { CONTAINER_PROCESS_PATH, type ProcessFeedRequest } from '../../src/containerProtocol';
import { processFeedTarget } from '../../src/feedProcessor';
import { withOdptConsumerKey } from '../../src/sources/odpt';
import { createR2HttpBucket } from './r2HttpBucket';

export interface ContainerAppEnv {
	R2_BASE_URL: string;
}

function jsonResponse(value: object, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8' },
	});
}

async function parseProcessFeedRequest(request: Request): Promise<ProcessFeedRequest> {
	return (await request.json()) as ProcessFeedRequest;
}

export async function handleContainerRequest(
	request: Request,
	env: ContainerAppEnv,
	fetcher: typeof fetch = fetch,
): Promise<Response> {
	const url = new URL(request.url);
	if (url.pathname !== CONTAINER_PROCESS_PATH) {
		return new Response('not found', { status: 404 });
	}
	if (request.method !== 'POST') {
		return new Response('method not allowed', { status: 405 });
	}

	let body: ProcessFeedRequest;
	try {
		body = await parseProcessFeedRequest(request);
	} catch {
		return jsonResponse({ error: 'invalid process-feed json' }, 400);
	}

	const bucket = createR2HttpBucket({ baseUrl: env.R2_BASE_URL, fetcher });
	const status = await processFeedTarget({
		bucket,
		fetcher: withOdptConsumerKey(fetcher, body.odptConsumerKey),
		target: body.target,
	});
	return jsonResponse(status);
}
