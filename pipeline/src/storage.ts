export interface BucketLike {
	get(key: string): Promise<{ text(): Promise<string> } | null>;
	put(key: string, value: string): Promise<void>;
	list(options: {
		prefix: string;
		cursor?: string;
	}): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
	delete(keys: string[]): Promise<void>;
}

export async function readJson<T extends object>(bucket: BucketLike, key: string): Promise<T | null> {
	const obj = await bucket.get(key);
	if (obj === null) return null;
	try {
		return JSON.parse(await obj.text()) as T;
	} catch {
		return null;
	}
}

export async function putJson(bucket: BucketLike, key: string, value: object): Promise<void> {
	await bucket.put(key, JSON.stringify(value));
}

/** R2Bucket の戻り値をテスト用の最小インターフェースへ合わせる */
export function toBucketLike(bucket: R2Bucket): BucketLike {
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
