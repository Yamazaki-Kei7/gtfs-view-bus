export const R2_OUTBOUND_HOST = 'r2.internal';

const FEED_ARTIFACT_RE =
	/^feeds\/[^/]+\/(bundle\.json|routes\.geojson|stops\.geojson|timetable\.json|meta\.json)$/;

export function isAllowedFeedArtifactKey(key: string): boolean {
	return FEED_ARTIFACT_RE.test(key);
}

function keyFromRequest(request: Request): string {
	const url = new URL(request.url);
	return decodeURIComponent(url.pathname.replace(/^\/+/, ''));
}

export function createR2OutboundHandler(bucket: R2Bucket): (request: Request) => Promise<Response> {
	return async (request) => {
		const key = keyFromRequest(request);
		if (!isAllowedFeedArtifactKey(key)) return new Response('forbidden r2 key', { status: 403 });

		if (request.method === 'GET') {
			const object = await bucket.get(key);
			if (!object) return new Response('not found', { status: 404 });
			return new Response(object.body, { status: 200 });
		}

		if (request.method === 'PUT') {
			await bucket.put(key, await request.text());
			return new Response(null, { status: 204 });
		}

		return new Response('method not allowed', { status: 405 });
	};
}
