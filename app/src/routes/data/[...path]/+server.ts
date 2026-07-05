import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, platform }) => {
	if (params.path !== 'feeds.json' && !params.path.startsWith('feeds/')) error(404, 'not found');
	const bucket = platform?.env?.DATA_BUCKET;
	if (!bucket) error(500, 'R2 binding is not available');
	const object = await bucket.get(params.path);
	if (!object) error(404, 'not found');
	const contentType = params.path.endsWith('.geojson')
		? 'application/geo+json'
		: 'application/json';
	const headers = new Headers();
	// object.writeHttpMetadata(headers) fails under the vite dev platform proxy
	// (miniflare cannot serialize a Headers instance), so copy the same fields manually.
	const meta = object.httpMetadata;
	if (meta?.contentLanguage) headers.set('content-language', meta.contentLanguage);
	if (meta?.contentDisposition) headers.set('content-disposition', meta.contentDisposition);
	if (meta?.contentEncoding) headers.set('content-encoding', meta.contentEncoding);
	if (meta?.cacheExpiry) headers.set('expires', meta.cacheExpiry.toUTCString());
	headers.set('etag', object.httpEtag);
	headers.set('content-type', contentType);
	headers.set('cache-control', 'public, max-age=300');
	return new Response(object.body as unknown as BodyInit, { headers });
};
