import type { BucketLike } from '../../src/storage';

export interface R2HttpBucketOptions {
	baseUrl: string;
	fetcher: typeof fetch;
}

function objectUrl(baseUrl: string, key: string): string {
	return `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(key).replace(/%2F/g, '/')}`;
}

export function createR2HttpBucket({ baseUrl, fetcher }: R2HttpBucketOptions): BucketLike {
	return {
		async get(key) {
			const res = await fetcher(objectUrl(baseUrl, key));
			if (res.status === 404) return null;
			if (!res.ok) throw new Error(`R2 outbound get failed: ${res.status} ${key}`);
			const text = await res.text();
			return { text: async () => text };
		},
		async put(key, value) {
			const res = await fetcher(objectUrl(baseUrl, key), { method: 'PUT', body: value });
			if (!res.ok) throw new Error(`R2 outbound put failed: ${res.status} ${key}`);
		},
		async list() {
			throw new Error('R2 HTTP bucket does not support list');
		},
		async delete() {
			throw new Error('R2 HTTP bucket does not support delete');
		},
	};
}
