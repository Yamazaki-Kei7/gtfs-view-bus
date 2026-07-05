import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, platform }) => {
	const bucket = platform?.env?.DATA_BUCKET;
	if (!bucket) error(500, 'R2 binding is not available');
	const object = await bucket.get(params.path);
	if (!object) error(404, 'not found');
	const contentType = params.path.endsWith('.geojson')
		? 'application/geo+json'
		: 'application/json';
	return new Response(object.body as unknown as BodyInit, {
		headers: {
			'content-type': contentType,
			'cache-control': 'public, max-age=300',
		},
	});
};
