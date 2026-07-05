// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { R2Bucket } from '@cloudflare/workers-types';

declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		interface Platform {
			env: {
				DATA_BUCKET: R2Bucket;
			};
		}
	}
}

export {};
