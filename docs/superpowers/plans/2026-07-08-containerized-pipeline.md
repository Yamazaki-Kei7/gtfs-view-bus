# Cloudflare Containersパイプライン移行 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Worker isolate内で実行しているGTFSフィード変換をCloudflare Containersへ移し、既存のCron、Queues、R2公開形式、アプリ側 `/data/*` 契約を維持したまま大規模フィードのメモリ制限を回避する。

**Architecture:** Cronは従来通り `FeedTarget[]` を作ってQueueへ1フィード1メッセージを投入する。Queue consumerは重い変換を実行せず、Container Durable Objectへ `FeedJobMessage` をPOSTし、Containerは既存 `processFeedTarget()` をHTTP経由の `BucketLike` で再利用してR2へ成果物を直接書く。Workerへ戻す値は小さな `FeedStatus` だけにし、既存のjob status保存と `maybeFinalizeJob()` を維持する。

**Tech Stack:** TypeScript / Cloudflare Workers (Cron, Queues, R2, Durable Objects) / Cloudflare Containers (`@cloudflare/containers`) / Wrangler JSONC / Node.js 22 container runtime / gtfs-core / fflate / Vitest / pnpm workspace / Docker

## Global Constraints

- 既存のCloudflare Queuesは残し、1フィード1メッセージのジョブ分配を維持する。
- Queue consumerはGTFS変換を直接行わず、Containerへ `FeedJobMessage` を委譲する。
- ContainerはGTFS zip取得、展開、`gtfs-core` による変換、R2成果物書き込みまで担当する。
- ContainerからR2へはCloudflare Containersのoutbound handlerを使い、R2のS3互換APIキーをContainerへ渡さない。
- `feeds.json`、`feeds/<feedId>/bundle.json`、`routes.geojson`、`stops.geojson`、`timetable.json`、`meta.json` の公開キーとschemaは変更しない。
- `feeds.json` は従来通り、全フィードのjob statusが揃った後だけ差し替える。
- 初期運用は安定優先とし、Container `max_instances` とQueue `max_concurrency` を小さめに揃える。
- TypeScriptの `class` は原則避けるが、Cloudflare Containersは `Container` 継承クラスが必要なため、その部分だけ例外とする。
- Queue consumerのDuration limitは15分である。Container同期処理は1フィード15分以内に収める。
- ODPTのキー付き配布URLをContainerで取得するため、`ODPT_CONSUMER_KEY` をContainer runtime envへ渡す。キーはmanifest、Queue message、R2には保存しない。
- TypeScriptで `any` / `unknown` / 不要な `class` を使わない。
- コードコメント、ドキュメント、コミットメッセージ本文は日本語で書く。
- パッケージマネージャはpnpm。pipelineの検証は `pnpm --filter pipeline test`、`pnpm --filter pipeline check`、`pnpm --filter pipeline cf:types`、`pnpm --filter pipeline cf:check` を使う。
- Cloudflare Containers / Workers / Queues / WranglerのAPIと設定は、Context7とCloudflare Docsで確認した現行形に合わせる。`containers`、同名 `durable_objects.bindings`、`migrations.new_sqlite_classes` を使う。

---

## File Structure

- Create: `pipeline/src/containerProtocol.ts`  
  WorkerとContainerアプリが共有する `ProcessFeedRequest`、`ProcessFeedResponse`、Container instance名、dispatcher timeout、`FeedStatus` レスポンス検証を持つ。
- Create: `pipeline/src/containerProtocol.test.ts`  
  instance名生成とレスポンス検証の単体テスト。
- Create: `pipeline/src/r2Outbound.ts`  
  Container outbound handlerからR2 bindingを操作する純関数。`feeds/<feedId>/...` の必要キーだけを許可する。
- Create: `pipeline/src/r2Outbound.test.ts`  
  GET/PUT、キー制限、method制限の単体テスト。
- Create: `pipeline/container-app/src/r2HttpBucket.ts`  
  Container内Nodeアプリが outbound handlerへHTTPする `BucketLike` 実装。
- Create: `pipeline/container-app/src/r2HttpBucket.test.ts`  
  HTTP GET/PUTと404を `BucketLike` として扱うテスト。
- Create: `pipeline/container-app/src/app.ts`  
  `POST /process-feed` を処理し、既存 `processFeedTarget()` をContainer内で呼ぶHTTPアプリ本体。
- Create: `pipeline/container-app/src/app.test.ts`  
  Containerアプリが小さなfixture zipを変換してR2 writerへ成果物を書くテスト。
- Create: `pipeline/container-app/src/server.ts`  
  Node.js HTTP server entrypoint。Cloudflare Containerはこのserverを起動する。
- Create: `pipeline/Dockerfile`  
  pnpm workspaceをContainer imageへ入れ、`tsx` で `container-app/src/server.ts` を起動する。
- Create: `pipeline/src/container.ts`  
  `FeedProcessorContainer extends Container`。`outboundByHost` でR2仮想ホストを `r2Outbound.ts` へつなぐ。
- Create: `pipeline/src/containerDispatcher.ts`  
  Queue consumerからContainerへ `FeedJobMessage` を送り、`FeedStatus` を返す。
- Create: `pipeline/src/containerDispatcher.test.ts`  
  dispatcherの正常系、HTTP 500、JSON不正、status不正を検証する。
- Modify: `pipeline/src/consumer.ts` / `pipeline/src/consumer.test.ts`  
  `processFeedTarget()` 直接呼び出しを注入可能な `FeedJobProcessor` へ置き換え、Container dispatcherを使えるようにする。
- Modify: `pipeline/src/index.ts`  
  `queue()` handlerでContainer resolverを作り、consumerへ渡す。
- Modify: `pipeline/src/env.d.ts`  
  `FEED_PROCESSOR_CONTAINER` bindingと `ODPT_CONSUMER_KEY` を宣言する。
- Modify: `pipeline/wrangler.jsonc`  
  Containers、Durable Object binding、migration、`max_concurrency: 5`、Container image設定を追加する。
- Modify: `pipeline/package.json` / `pnpm-lock.yaml`  
  `@cloudflare/containers` を追加し、`tsx` をContainer runtimeでも使える依存へ移す。Node entrypointの型検査用に `@types/node` を追加する。
- Modify: `pipeline/tsconfig.json` / `pipeline/vitest.config.ts`  
  `container-app/src` と `container-app/**/*.test.ts` を型チェック・テスト対象に含める。
- Modify: `pipeline/README.md` / `README.md`  
  Containers移行後のローカル実行、Docker前提、検証コマンド、初期運用の確認点を更新する。

---

### Task 1: Container通信プロトコルを追加する

**Files:**
- Create: `pipeline/src/containerProtocol.ts`
- Create: `pipeline/src/containerProtocol.test.ts`

**Interfaces:**
- Consumes: `FeedJobMessage`, `FeedStatus` from `pipeline/src/jobState.ts`
- Produces:
  - `ProcessFeedRequest`
  - `ProcessFeedResponse`
  - `CONTAINER_PROCESS_PATH`
  - `CONTAINER_PROCESS_TIMEOUT_MS`
  - `containerInstanceName(jobId: string, feedId: string): string`
  - `parseFeedStatusResponse(text: string): FeedStatus`

- [ ] **Step 1: 失敗するテストを書く**

`pipeline/src/containerProtocol.test.ts` を作成する。

```ts
import { describe, expect, it } from 'vitest';
import {
	CONTAINER_PROCESS_TIMEOUT_MS,
	containerInstanceName,
	parseFeedStatusResponse,
} from './containerProtocol';

describe('containerProtocol', () => {
	it('jobIdとfeedIdからContainer instance名を安定生成する', () => {
		expect(containerInstanceName('20260708T010203Z-a1b2c3', 'odpt~A/B~feed 1')).toBe(
			'feed-20260708T010203Z-a1b2c3-odpt~A%2FB~feed%201',
		);
	});

	it('Queue consumerの15分制限より短いtimeoutを使う', () => {
		expect(CONTAINER_PROCESS_TIMEOUT_MS).toBe(14 * 60 * 1000);
	});

	it('Containerから返るFeedStatus JSONを検証して返す', () => {
		const status = parseFeedStatusResponse(
			JSON.stringify({
				id: 'feed-1',
				name: 'フィード1',
				orgName: '事業者',
				license: null,
				fromDate: '2026-04-01',
				toDate: '2027-03-31',
				source: 'gtfs-data.jp',
				prefId: 10,
				status: 'updated',
				shapeSourceCounts: { shapes: 1, route: 0, straight: 0 },
			}),
		);
		expect(status).toEqual({
			id: 'feed-1',
			name: 'フィード1',
			orgName: '事業者',
			license: null,
			fromDate: '2026-04-01',
			toDate: '2027-03-31',
			source: 'gtfs-data.jp',
			prefId: 10,
			status: 'updated',
			shapeSourceCounts: { shapes: 1, route: 0, straight: 0 },
		});
	});

	it('不正なstatus値はrejectする', () => {
		expect(() =>
			parseFeedStatusResponse(
				JSON.stringify({
					id: 'feed-1',
					name: 'フィード1',
					orgName: '事業者',
					license: null,
					fromDate: '',
					toDate: '',
					source: 'gtfs-data.jp',
					status: 'broken',
				}),
			),
		).toThrow('container status response malformed: status');
	});
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter pipeline exec vitest run src/containerProtocol.test.ts`

Expected: FAIL。`./containerProtocol` が存在しない。

- [ ] **Step 3: 実装を書く**

`pipeline/src/containerProtocol.ts` を作成する。

```ts
import type { FeedJobMessage, FeedStatus } from './jobState';
import type { SourceId } from './sources/types';

export const CONTAINER_PROCESS_PATH = '/process-feed';
export const CONTAINER_PROCESS_TIMEOUT_MS = 14 * 60 * 1000;

export interface ProcessFeedRequest extends FeedJobMessage {}

export type ProcessFeedResponse = FeedStatus;

export function containerInstanceName(jobId: string, feedId: string): string {
	return `feed-${jobId}-${encodeURIComponent(feedId)}`;
}

function isSourceId(value: string | undefined): value is SourceId {
	return value === 'gtfs-data.jp' || value === 'odpt';
}

function isStatus(value: string | undefined): value is FeedStatus['status'] {
	return value === 'updated' || value === 'unchanged' || value === 'error';
}

function shapeSourceCounts(value: Partial<FeedStatus>): Record<string, number> | undefined {
	const counts = value.shapeSourceCounts;
	if (counts === undefined) return undefined;
	if (counts === null || Array.isArray(counts) || typeof counts !== 'object') {
		throw new Error('container status response malformed: shapeSourceCounts');
	}
	for (const [key, count] of Object.entries(counts)) {
		if (typeof key !== 'string' || typeof count !== 'number') {
			throw new Error('container status response malformed: shapeSourceCounts');
		}
	}
	return counts;
}

export function parseFeedStatusResponse(text: string): ProcessFeedResponse {
	const parsed = JSON.parse(text) as Partial<FeedStatus>;
	if (typeof parsed.id !== 'string') throw new Error('container status response malformed: id');
	if (typeof parsed.name !== 'string') throw new Error('container status response malformed: name');
	if (typeof parsed.orgName !== 'string') {
		throw new Error('container status response malformed: orgName');
	}
	if (!(typeof parsed.license === 'string' || parsed.license === null)) {
		throw new Error('container status response malformed: license');
	}
	if (typeof parsed.fromDate !== 'string') {
		throw new Error('container status response malformed: fromDate');
	}
	if (typeof parsed.toDate !== 'string') {
		throw new Error('container status response malformed: toDate');
	}
	if (!isSourceId(parsed.source)) throw new Error('container status response malformed: source');
	if (!isStatus(parsed.status)) throw new Error('container status response malformed: status');
	if (
		parsed.prefId !== undefined &&
		parsed.prefId !== null &&
		(typeof parsed.prefId !== 'number' || !Number.isInteger(parsed.prefId))
	) {
		throw new Error('container status response malformed: prefId');
	}
	if (parsed.error !== undefined && typeof parsed.error !== 'string') {
		throw new Error('container status response malformed: error');
	}
	return {
		id: parsed.id,
		name: parsed.name,
		orgName: parsed.orgName,
		license: parsed.license,
		fromDate: parsed.fromDate,
		toDate: parsed.toDate,
		source: parsed.source,
		prefId: parsed.prefId,
		status: parsed.status,
		error: parsed.error,
		shapeSourceCounts: shapeSourceCounts(parsed),
	};
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm --filter pipeline exec vitest run src/containerProtocol.test.ts`

Expected: PASS。

- [ ] **Step 5: コミット**

```bash
git add pipeline/src/containerProtocol.ts pipeline/src/containerProtocol.test.ts
git commit -m "feat(pipeline): Container処理プロトコルを追加"
```

---

### Task 2: R2 outbound handlerを追加する

**Files:**
- Create: `pipeline/src/r2Outbound.ts`
- Create: `pipeline/src/r2Outbound.test.ts`

**Interfaces:**
- Consumes: `R2Bucket`
- Produces:
  - `R2_OUTBOUND_HOST = 'r2.internal'`
  - `createR2OutboundHandler(bucket: R2Bucket): (request: Request) => Promise<Response>`
  - `isAllowedFeedArtifactKey(key: string): boolean`

- [ ] **Step 1: 失敗するテストを書く**

`pipeline/src/r2Outbound.test.ts` を作成する。

```ts
import { describe, expect, it } from 'vitest';
import { createR2OutboundHandler, isAllowedFeedArtifactKey } from './r2Outbound';

function fakeR2(): R2Bucket & { store: Map<string, string> } {
	const store = new Map<string, string>();
	return {
		store,
		get: async (key: string) => {
			const value = store.get(key);
			return value === undefined ? null : ({ body: value, text: async () => value } as R2ObjectBody);
		},
		put: async (key: string, value: string | ReadableStream | ArrayBuffer) => {
			store.set(key, typeof value === 'string' ? value : '');
			return null;
		},
	} as R2Bucket & { store: Map<string, string> };
}

describe('r2Outbound', () => {
	it('feeds配下の成果物キーだけ許可する', () => {
		expect(isAllowedFeedArtifactKey('feeds/feed-1/bundle.json')).toBe(true);
		expect(isAllowedFeedArtifactKey('feeds/feed-1/routes.geojson')).toBe(true);
		expect(isAllowedFeedArtifactKey('feeds/feed-1/stops.geojson')).toBe(true);
		expect(isAllowedFeedArtifactKey('feeds/feed-1/timetable.json')).toBe(true);
		expect(isAllowedFeedArtifactKey('feeds/feed-1/meta.json')).toBe(true);
		expect(isAllowedFeedArtifactKey('feeds/feed-1/other.json')).toBe(false);
		expect(isAllowedFeedArtifactKey('pipeline/jobs/job-1/status.json')).toBe(false);
	});

	it('PUTで許可キーへ書き込み、GETで読み戻す', async () => {
		const r2 = fakeR2();
		const handler = createR2OutboundHandler(r2);

		const put = await handler(
			new Request('http://r2.internal/feeds/feed-1/bundle.json', {
				method: 'PUT',
				body: '{"ok":true}',
			}),
		);
		expect(put.status).toBe(204);

		const get = await handler(new Request('http://r2.internal/feeds/feed-1/bundle.json'));
		expect(get.status).toBe(200);
		expect(await get.text()).toBe('{"ok":true}');
	});

	it('存在しないキーは404を返す', async () => {
		const handler = createR2OutboundHandler(fakeR2());
		const res = await handler(new Request('http://r2.internal/feeds/feed-1/meta.json'));
		expect(res.status).toBe(404);
	});

	it('許可されていないキーは403を返す', async () => {
		const handler = createR2OutboundHandler(fakeR2());
		const res = await handler(new Request('http://r2.internal/pipeline/jobs/current.json'));
		expect(res.status).toBe(403);
	});

	it('GETとPUT以外は405を返す', async () => {
		const handler = createR2OutboundHandler(fakeR2());
		const res = await handler(
			new Request('http://r2.internal/feeds/feed-1/meta.json', { method: 'DELETE' }),
		);
		expect(res.status).toBe(405);
	});
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter pipeline exec vitest run src/r2Outbound.test.ts`

Expected: FAIL。`./r2Outbound` が存在しない。

- [ ] **Step 3: 実装を書く**

`pipeline/src/r2Outbound.ts` を作成する。

```ts
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
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm --filter pipeline exec vitest run src/r2Outbound.test.ts`

Expected: PASS。

- [ ] **Step 5: コミット**

```bash
git add pipeline/src/r2Outbound.ts pipeline/src/r2Outbound.test.ts
git commit -m "feat(pipeline): Container用R2 outbound handlerを追加"
```

---

### Task 3: Container内のR2 HTTP BucketLikeを追加する

**Files:**
- Create: `pipeline/container-app/src/r2HttpBucket.ts`
- Create: `pipeline/container-app/src/r2HttpBucket.test.ts`
- Modify: `pipeline/vitest.config.ts`
- Modify: `pipeline/tsconfig.json`

**Interfaces:**
- Consumes: `BucketLike` from `pipeline/src/storage.ts`
- Produces:
  - `createR2HttpBucket(options: R2HttpBucketOptions): BucketLike`
  - `R2HttpBucketOptions { baseUrl: string; fetcher: typeof fetch }`

- [ ] **Step 1: 失敗するテストを書く**

`pipeline/container-app/src/r2HttpBucket.test.ts` を作成する。

```ts
import { describe, expect, it } from 'vitest';
import { createR2HttpBucket } from './r2HttpBucket';

function recordingFetcher(
	responses: Map<string, Response>,
	calls: { url: string; method: string; body?: string }[],
): typeof fetch {
	const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = String(input);
		const method = init?.method ?? 'GET';
		const body = typeof init?.body === 'string' ? init.body : undefined;
		calls.push({ url, method, body });
		return responses.get(`${method} ${url}`) ?? new Response('not found', { status: 404 });
	};
	return impl as typeof fetch;
}

describe('createR2HttpBucket', () => {
	it('getはHTTP 200をtext付きobjectとして返す', async () => {
		const calls: { url: string; method: string }[] = [];
		const bucket = createR2HttpBucket({
			baseUrl: 'http://r2.internal',
			fetcher: recordingFetcher(
				new Map([['GET http://r2.internal/feeds/feed-1/meta.json', new Response('{"ok":true}')]]),
				calls,
			),
		});

		const object = await bucket.get('feeds/feed-1/meta.json');
		expect(object ? await object.text() : null).toBe('{"ok":true}');
		expect(calls).toEqual([{ url: 'http://r2.internal/feeds/feed-1/meta.json', method: 'GET' }]);
	});

	it('getはHTTP 404をnullとして返す', async () => {
		const calls: { url: string; method: string }[] = [];
		const bucket = createR2HttpBucket({
			baseUrl: 'http://r2.internal',
			fetcher: recordingFetcher(new Map(), calls),
		});

		await expect(bucket.get('feeds/feed-1/meta.json')).resolves.toBeNull();
	});

	it('putはHTTP PUTで文字列を書き込む', async () => {
		const calls: { url: string; method: string; body?: string }[] = [];
		const bucket = createR2HttpBucket({
			baseUrl: 'http://r2.internal',
			fetcher: recordingFetcher(
				new Map([['PUT http://r2.internal/feeds/feed-1/bundle.json', new Response(null, { status: 204 })]]),
				calls,
			),
		});

		await bucket.put('feeds/feed-1/bundle.json', '{"ok":true}');
		expect(calls).toEqual([
			{
				url: 'http://r2.internal/feeds/feed-1/bundle.json',
				method: 'PUT',
				body: '{"ok":true}',
			},
		]);
	});

	it('put失敗はthrowする', async () => {
		const calls: { url: string; method: string }[] = [];
		const bucket = createR2HttpBucket({
			baseUrl: 'http://r2.internal',
			fetcher: recordingFetcher(
				new Map([['PUT http://r2.internal/feeds/feed-1/bundle.json', new Response('bad', { status: 500 })]]),
				calls,
			),
		});

		await expect(bucket.put('feeds/feed-1/bundle.json', '{}')).rejects.toThrow(
			'R2 outbound put failed: 500 feeds/feed-1/bundle.json',
		);
	});
});
```

- [ ] **Step 2: Vitest設定を先に広げ、テストが失敗することを確認**

`pipeline/vitest.config.ts` を変更する。

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: { include: ['src/**/*.test.ts', 'container-app/**/*.test.ts'] },
});
```

`pipeline/tsconfig.json` の `include` を変更する。

```json
{
	"compilerOptions": {
		"target": "ES2022",
		"module": "ESNext",
		"moduleResolution": "bundler",
		"strict": true,
		"skipLibCheck": true,
		"noEmit": true,
		"resolveJsonModule": true,
		"types": ["@cloudflare/workers-types"]
	},
	"include": ["src", "scripts", "container-app/src"]
}
```

Run: `pnpm --filter pipeline exec vitest run container-app/src/r2HttpBucket.test.ts`

Expected: FAIL。`./r2HttpBucket` が存在しない。

- [ ] **Step 3: 実装を書く**

`pipeline/container-app/src/r2HttpBucket.ts` を作成する。

```ts
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
```

- [ ] **Step 4: テストと型チェックを通す**

Run: `pnpm --filter pipeline exec vitest run container-app/src/r2HttpBucket.test.ts`

Expected: PASS。

Run: `pnpm --filter pipeline check`

Expected: PASS。

- [ ] **Step 5: コミット**

```bash
git add pipeline/container-app/src/r2HttpBucket.ts pipeline/container-app/src/r2HttpBucket.test.ts pipeline/vitest.config.ts pipeline/tsconfig.json
git commit -m "feat(pipeline): Container内R2 HTTP bucketを追加"
```

---

### Task 4: Containerアプリ本体を追加する

**Files:**
- Create: `pipeline/container-app/src/app.ts`
- Create: `pipeline/container-app/src/app.test.ts`

**Interfaces:**
- Consumes:
  - `ProcessFeedRequest` from `pipeline/src/containerProtocol.ts`
  - `processFeedTarget(deps): Promise<FeedStatus>` from `pipeline/src/feedProcessor.ts`
  - `withOdptConsumerKey(fetcher, consumerKey)` from `pipeline/src/sources/odpt.ts`
  - `createR2HttpBucket(options): BucketLike`
- Produces:
  - `ContainerAppEnv { R2_BASE_URL: string; ODPT_CONSUMER_KEY?: string }`
  - `handleContainerRequest(request: Request, env: ContainerAppEnv, fetcher?: typeof fetch): Promise<Response>`

- [ ] **Step 1: 失敗するテストを書く**

`pipeline/container-app/src/app.test.ts` を作成する。

```ts
import { strToU8, zipSync } from 'fflate';
import { FIXTURE_FILES, FIXTURE_ROUTES_GEOJSON } from 'gtfs-core';
import { describe, expect, it } from 'vitest';
import { handleContainerRequest } from './app';

const FIXTURE_ZIP = zipSync(
	Object.fromEntries(Object.entries(FIXTURE_FILES).map(([key, value]) => [key, strToU8(value)])),
);

function fetcher(store: Map<string, string>, calls: string[]): typeof fetch {
	const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = String(input);
		calls.push(url);
		if (url === 'https://example.com/feed.zip') return new Response(FIXTURE_ZIP);
		if (url === 'https://example.com/routes.geojson') return new Response(FIXTURE_ROUTES_GEOJSON);
		if (url.startsWith('http://r2.internal/')) {
			const key = decodeURIComponent(new URL(url).pathname.slice(1));
			if (init?.method === 'PUT') {
				store.set(key, typeof init.body === 'string' ? init.body : '');
				return new Response(null, { status: 204 });
			}
			const value = store.get(key);
			return value === undefined ? new Response('not found', { status: 404 }) : new Response(value);
		}
		return new Response('not found', { status: 404 });
	};
	return impl as typeof fetch;
}

function processRequest(): Request {
	return new Request('http://container/process-feed', {
		method: 'POST',
		body: JSON.stringify({
			jobId: 'job-1',
			target: {
				id: 'feed-1',
				name: 'フィード1',
				orgName: '事業者',
				license: null,
				fromDate: '2026-04-01',
				toDate: '2027-03-31',
				source: 'gtfs-data.jp',
				versionId: 'v1',
				zipUrl: 'https://example.com/feed.zip',
				routesGeojsonUrl: 'https://example.com/routes.geojson',
				prefId: 10,
			},
		}),
	});
}

describe('handleContainerRequest', () => {
	it('POST /process-feedでGTFSを変換してR2へ成果物を書く', async () => {
		const store = new Map<string, string>();
		const calls: string[] = [];

		const res = await handleContainerRequest(
			processRequest(),
			{ R2_BASE_URL: 'http://r2.internal' },
			fetcher(store, calls),
		);

		expect(res.status).toBe(200);
		const status = (await res.json()) as { status?: string; prefId?: number | null };
		expect(status.status).toBe('updated');
		expect(status.prefId).toBe(10);
		expect(store.has('feeds/feed-1/bundle.json')).toBe(true);
		expect(store.has('feeds/feed-1/routes.geojson')).toBe(true);
		expect(store.has('feeds/feed-1/stops.geojson')).toBe(true);
		expect(store.has('feeds/feed-1/timetable.json')).toBe(true);
		expect(store.has('feeds/feed-1/meta.json')).toBe(true);
	});

	it('GETは405を返す', async () => {
		const res = await handleContainerRequest(
			new Request('http://container/process-feed'),
			{ R2_BASE_URL: 'http://r2.internal' },
			fetcher(new Map(), []),
		);
		expect(res.status).toBe(405);
	});

	it('不正JSONは400を返す', async () => {
		const res = await handleContainerRequest(
			new Request('http://container/process-feed', { method: 'POST', body: '{' }),
			{ R2_BASE_URL: 'http://r2.internal' },
			fetcher(new Map(), []),
		);
		expect(res.status).toBe(400);
	});
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter pipeline exec vitest run container-app/src/app.test.ts`

Expected: FAIL。`./app` が存在しない。

- [ ] **Step 3: app本体を書く**

`pipeline/container-app/src/app.ts` を作成する。

```ts
import { CONTAINER_PROCESS_PATH, type ProcessFeedRequest } from '../../src/containerProtocol';
import { processFeedTarget } from '../../src/feedProcessor';
import { withOdptConsumerKey } from '../../src/sources/odpt';
import { createR2HttpBucket } from './r2HttpBucket';

export interface ContainerAppEnv {
	R2_BASE_URL: string;
	ODPT_CONSUMER_KEY?: string;
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
	if (url.pathname !== CONTAINER_PROCESS_PATH) return new Response('not found', { status: 404 });
	if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

	let body: ProcessFeedRequest;
	try {
		body = await parseProcessFeedRequest(request);
	} catch {
		return jsonResponse({ error: 'invalid process-feed json' }, 400);
	}

	const bucket = createR2HttpBucket({ baseUrl: env.R2_BASE_URL, fetcher });
	const status = await processFeedTarget({
		bucket,
		fetcher: withOdptConsumerKey(fetcher, env.ODPT_CONSUMER_KEY),
		target: body.target,
	});
	return jsonResponse(status);
}
```

- [ ] **Step 4: テストと型チェックを通す**

Run: `pnpm --filter pipeline exec vitest run container-app/src/app.test.ts`

Expected: PASS。

Run: `pnpm --filter pipeline check`

Expected: PASS。

- [ ] **Step 5: コミット**

```bash
git add pipeline/container-app/src/app.ts pipeline/container-app/src/app.test.ts
git commit -m "feat(pipeline): GTFS変換Containerアプリを追加"
```

---

### Task 5: Container dependency、Dockerfile、Wrangler設定を追加する

**Files:**
- Modify: `pipeline/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `pipeline/container-app/src/server.ts`
- Create: `pipeline/Dockerfile`
- Create: `pipeline/src/container.ts`
- Modify: `pipeline/src/env.d.ts`
- Modify: `pipeline/tsconfig.json`
- Modify: `pipeline/wrangler.jsonc`

**Interfaces:**
- Consumes:
  - `createR2OutboundHandler(bucket)` and `R2_OUTBOUND_HOST`
  - `handleContainerRequest()` server listening on port 8080
- Produces:
  - `FeedProcessorContainer`
  - Env binding `FEED_PROCESSOR_CONTAINER: DurableObjectNamespace`
  - Wrangler `containers` config with `max_instances: 5` and `instance_type: "standard-1"`

- [ ] **Step 1: Container dependencyとNode型を追加する**

Run: `pnpm --filter pipeline add @cloudflare/containers tsx`

Expected: `pipeline/package.json` の `dependencies` に `@cloudflare/containers` と `tsx` が入り、`pnpm-lock.yaml` が更新される。

Run: `pnpm --filter pipeline add -D @types/node`

Expected: `pipeline/package.json` の `devDependencies` に `@types/node` が入り、`pnpm-lock.yaml` が更新される。

- [ ] **Step 2: Node server entrypointを書く**

`pipeline/container-app/src/server.ts` を作成する。

```ts
import { createServer, type IncomingMessage } from 'node:http';
import { handleContainerRequest, type ContainerAppEnv } from './app';

const PORT = Number(process.env.PORT ?? '8080');

function env(): ContainerAppEnv {
	return {
		R2_BASE_URL: process.env.R2_BASE_URL ?? 'http://r2.internal',
		ODPT_CONSUMER_KEY: process.env.ODPT_CONSUMER_KEY,
	};
}

async function requestBody(request: IncomingMessage): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of request) {
		chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
	}
	const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

createServer(async (req, res) => {
	const url = `http://localhost:${PORT}${req.url ?? '/'}`;
	const request = new Request(url, {
		method: req.method,
		headers: req.headers as HeadersInit,
		body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await requestBody(req),
	});
	const response = await handleContainerRequest(request, env());
	res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
	res.end(new Uint8Array(await response.arrayBuffer()));
}).listen(PORT, () => {
	console.log(`Feed processor container listening on ${PORT}`);
});
```

- [ ] **Step 3: tsconfigへNode型を追加する**

`pipeline/tsconfig.json` の `types` を更新する。

```json
{
	"compilerOptions": {
		"target": "ES2022",
		"module": "ESNext",
		"moduleResolution": "bundler",
		"strict": true,
		"skipLibCheck": true,
		"noEmit": true,
		"resolveJsonModule": true,
		"types": ["@cloudflare/workers-types", "node"]
	},
	"include": ["src", "scripts", "container-app/src"]
}
```

- [ ] **Step 4: Dockerfileを書く**

`pipeline/Dockerfile` を作成する。

```dockerfile
FROM node:22-slim

WORKDIR /workspace

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY pipeline/package.json pipeline/package.json
COPY packages/gtfs-core/package.json packages/gtfs-core/package.json

RUN pnpm install --frozen-lockfile

COPY pipeline pipeline
COPY packages/gtfs-core packages/gtfs-core

WORKDIR /workspace/pipeline

ENV NODE_ENV=production
ENV PORT=8080
ENV R2_BASE_URL=http://r2.internal

EXPOSE 8080

CMD ["pnpm", "exec", "tsx", "container-app/src/server.ts"]
```

- [ ] **Step 5: Container Durable Object classを書く**

`pipeline/src/container.ts` を作成する。

```ts
import { Container } from '@cloudflare/containers';
import { createR2OutboundHandler, R2_OUTBOUND_HOST } from './r2Outbound';

interface ContainerOutboundContext {
	containerId: string;
}

type ContainerOutboundHandler = (
	request: Request,
	env: Env,
	ctx: ContainerOutboundContext,
) => Promise<Response>;

const r2Handler: ContainerOutboundHandler = async (request, env) =>
	createR2OutboundHandler(env.DATA_BUCKET)(request);

export class FeedProcessorContainer extends Container {
	defaultPort = 8080;
	sleepAfter = '2m';
	envVars = {
		R2_BASE_URL: `http://${R2_OUTBOUND_HOST}`,
	};
}

FeedProcessorContainer.outboundByHost = {
	[R2_OUTBOUND_HOST]: r2Handler,
};
```

- [ ] **Step 6: Env型を拡張する**

`pipeline/src/env.d.ts` を次の内容へ更新する。

```ts
// wrangler types が生成する Env(worker-configuration.d.ts)へのプロジェクト固有の拡張。
// シークレットは wrangler.jsonc に現れないため、ここで宣言をマージする。
interface Env {
	/** ODPT開発者キー(任意)。設定時のみ api.odpt.org 配布フィードを処理対象に含める。
	 *  本番: `wrangler secret put ODPT_CONSUMER_KEY` / ローカル: `pipeline/.dev.vars` */
	ODPT_CONSUMER_KEY?: string;
	/** GTFS変換を実行するCloudflare Container Durable Object binding */
	FEED_PROCESSOR_CONTAINER: DurableObjectNamespace;
}
```

- [ ] **Step 7: Wrangler設定を更新する**

`pipeline/wrangler.jsonc` を更新する。既存設定は維持し、次の差分を入れる。

```jsonc
{
	"name": "gtfs-view-bus-pipeline",
	"main": "src/index.ts",
	"compatibility_date": "2026-07-07",
	"containers": [
		{
			"class_name": "FeedProcessorContainer",
			"image": "./Dockerfile",
			"image_build_context": "..",
			"max_instances": 5,
			"instance_type": "standard-1"
		}
	],
	"durable_objects": {
		"bindings": [
			{
				"name": "FEED_PROCESSOR_CONTAINER",
				"class_name": "FeedProcessorContainer"
			}
		]
	},
	"migrations": [
		{
			"tag": "v1-feed-processor-container",
			"new_sqlite_classes": ["FeedProcessorContainer"]
		}
	],
	"queues": {
		"consumers": [
			{
				"queue": "gtfs-view-bus-feed-jobs",
				"max_batch_size": 1,
				"max_batch_timeout": 5,
				"max_retries": 3,
				"dead_letter_queue": "gtfs-view-bus-feed-jobs-dlq",
				"max_concurrency": 5,
				"retry_delay": 30
			}
		]
	}
}
```

既存の `triggers`、`r2_buckets`、`queues.producers`、`limits`、`observability` は削除しない。

- [ ] **Step 8: 型チェックを通す**

Run: `pnpm --filter pipeline check`

Expected: PASS。

- [ ] **Step 9: Wrangler型を更新する**

Run: `pnpm --filter pipeline cf:types`

Expected: PASS。`pipeline/worker-configuration.d.ts` に `FEED_PROCESSOR_CONTAINER` が追加される。

- [ ] **Step 10: コミット**

```bash
git add pipeline/package.json pnpm-lock.yaml pipeline/container-app/src/server.ts pipeline/Dockerfile pipeline/src/container.ts pipeline/src/env.d.ts pipeline/tsconfig.json pipeline/wrangler.jsonc pipeline/worker-configuration.d.ts
git commit -m "feat(pipeline): Cloudflare Container設定を追加"
```

---

### Task 6: Container dispatcherを追加する

**Files:**
- Create: `pipeline/src/containerDispatcher.ts`
- Create: `pipeline/src/containerDispatcher.test.ts`

**Interfaces:**
- Consumes:
  - `FeedJobMessage`
  - `FeedStatus`
  - `CONTAINER_PROCESS_PATH`
  - `CONTAINER_PROCESS_TIMEOUT_MS`
  - `containerInstanceName(jobId, feedId)`
  - `parseFeedStatusResponse(text)`
- Produces:
  - `ContainerResolver`
  - `createContainerResolver(binding: DurableObjectNamespace): ContainerResolver`
  - `dispatchFeedToContainer(deps): Promise<FeedStatus>`

- [ ] **Step 1: 失敗するテストを書く**

`pipeline/src/containerDispatcher.test.ts` を作成する。

```ts
import { describe, expect, it } from 'vitest';
import { dispatchFeedToContainer, type ContainerResolver } from './containerDispatcher';
import type { FeedJobMessage } from './jobState';

function message(): FeedJobMessage {
	return {
		jobId: 'job-1',
		target: {
			id: 'feed-1',
			name: 'フィード1',
			orgName: '事業者',
			license: null,
			fromDate: '2026-04-01',
			toDate: '2027-03-31',
			source: 'gtfs-data.jp',
			versionId: 'v1',
			zipUrl: 'https://example.com/feed.zip',
		},
	};
}

function resolver(response: Response, names: string[], requests: Request[]): ContainerResolver {
	return {
		get(name) {
			names.push(name);
			return {
				async fetch(request) {
					requests.push(request);
					return response;
				},
			};
		},
	};
}

describe('dispatchFeedToContainer', () => {
	it('ContainerへFeedJobMessageをPOSTし、FeedStatusを返す', async () => {
		const names: string[] = [];
		const requests: Request[] = [];
		const status = await dispatchFeedToContainer({
			resolver: resolver(
				new Response(
					JSON.stringify({
						id: 'feed-1',
						name: 'フィード1',
						orgName: '事業者',
						license: null,
						fromDate: '2026-04-01',
						toDate: '2027-03-31',
						source: 'gtfs-data.jp',
						status: 'updated',
					}),
				),
				names,
				requests,
			),
			message: message(),
			timeoutMs: 1000,
		});

		expect(names).toEqual(['feed-job-1-feed-1']);
		expect(requests[0].method).toBe('POST');
		expect(new URL(requests[0].url).pathname).toBe('/process-feed');
		expect(await requests[0].text()).toBe(JSON.stringify(message()));
		expect(status.status).toBe('updated');
	});

	it('Container HTTPエラーはthrowする', async () => {
		await expect(
			dispatchFeedToContainer({
				resolver: resolver(new Response('broken', { status: 500 }), [], []),
				message: message(),
				timeoutMs: 1000,
			}),
		).rejects.toThrow('container process failed: 500');
	});

	it('ContainerレスポンスのJSONが不正ならthrowする', async () => {
		await expect(
			dispatchFeedToContainer({
				resolver: resolver(new Response('{'), [], []),
				message: message(),
				timeoutMs: 1000,
			}),
		).rejects.toThrow();
	});
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter pipeline exec vitest run src/containerDispatcher.test.ts`

Expected: FAIL。`./containerDispatcher` が存在しない。

- [ ] **Step 3: 実装を書く**

`pipeline/src/containerDispatcher.ts` を作成する。

```ts
import { getContainer } from '@cloudflare/containers';
import {
	CONTAINER_PROCESS_PATH,
	CONTAINER_PROCESS_TIMEOUT_MS,
	containerInstanceName,
	parseFeedStatusResponse,
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
	timeoutMs?: number;
}

export function createContainerResolver(binding: DurableObjectNamespace): ContainerResolver {
	return {
		get(name) {
			return getContainer(binding, name);
		},
	};
}

export async function dispatchFeedToContainer({
	resolver,
	message,
	timeoutMs = CONTAINER_PROCESS_TIMEOUT_MS,
}: DispatchFeedToContainerDeps): Promise<FeedStatus> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const container = resolver.get(containerInstanceName(message.jobId, message.target.id));
		const response = await container.fetch(
			new Request(`http://container${CONTAINER_PROCESS_PATH}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json; charset=utf-8' },
				body: JSON.stringify(message),
				signal: controller.signal,
			}),
		);
		if (!response.ok) throw new Error(`container process failed: ${response.status}`);
		return parseFeedStatusResponse(await response.text());
	} finally {
		clearTimeout(timeout);
	}
}
```

- [ ] **Step 4: テストと型チェックを通す**

Run: `pnpm --filter pipeline exec vitest run src/containerDispatcher.test.ts`

Expected: PASS。

Run: `pnpm --filter pipeline check`

Expected: PASS。

- [ ] **Step 5: コミット**

```bash
git add pipeline/src/containerDispatcher.ts pipeline/src/containerDispatcher.test.ts
git commit -m "feat(pipeline): QueueからContainerへ処理を委譲するdispatcherを追加"
```

---

### Task 7: Queue consumerをContainer委譲へ切り替える

**Files:**
- Modify: `pipeline/src/consumer.ts`
- Modify: `pipeline/src/consumer.test.ts`
- Modify: `pipeline/src/index.ts`

**Interfaces:**
- Consumes:
  - `dispatchFeedToContainer({ resolver, message }): Promise<FeedStatus>`
  - `createContainerResolver(env.FEED_PROCESSOR_CONTAINER)`
- Produces:
  - `FeedJobProcessor { process(message: FeedJobMessage): Promise<FeedStatus> }`
  - `processFeedJobMessage({ bucket, processor, message, now }): Promise<void>`

- [ ] **Step 1: consumerテストをContainer processor注入へ書き換える**

`pipeline/src/consumer.test.ts` から `fflate` と `gtfs-core` fixture依存を消し、`processor` fakeを使う。先頭のhelperを次の形へ置き換える。

```ts
import { describe, expect, it } from 'vitest';
import { processFeedJobMessage, type FeedJobProcessor } from './consumer';
import {
	CURRENT_JOB_KEY,
	type FeedJobMessage,
	type FeedJobStatus,
	type FeedStatus,
	jobManifestKey,
	jobStatusKey,
} from './jobState';
import type { BucketLike } from './storage';

function fakeBucket(): BucketLike & { store: Map<string, string> } {
	const store = new Map<string, string>();
	return {
		store,
		async get(key: string) {
			const value = store.get(key);
			return value === undefined ? null : { text: async () => value };
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
		async list({ prefix }: { prefix: string }) {
			return {
				objects: [...store.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
				truncated: false,
			};
		},
		async delete(keys: string[]) {
			for (const key of keys) store.delete(key);
		},
	};
}

function message(): FeedJobMessage {
	return {
		jobId: 'job-1',
		target: {
			id: 'feed-1',
			name: 'feed-1',
			orgName: 'org',
			license: null,
			fromDate: '',
			toDate: '',
			source: 'gtfs-data.jp',
			versionId: 'v1',
			zipUrl: 'https://example.com/feed.zip',
		},
	};
}

function status(value: FeedStatus['status'], error?: string): FeedStatus {
	return {
		id: 'feed-1',
		name: 'feed-1',
		orgName: 'org',
		license: null,
		fromDate: '',
		toDate: '',
		source: 'gtfs-data.jp',
		status: value,
		error,
		shapeSourceCounts: value === 'updated' ? { shapes: 1, route: 0, straight: 0 } : undefined,
	};
}

function processor(result: FeedStatus, calls: FeedJobMessage[]): FeedJobProcessor {
	return {
		async process(body) {
			calls.push(body);
			return result;
		},
	};
}
```

既存テストの `fetcher:` 引数を `processor:` に変える。通常失敗テストは次の期待値にする。

```ts
const calls: FeedJobMessage[] = [];
await processFeedJobMessage({
	bucket,
	processor: processor(status('error', 'zip fetch failed: 404'), calls),
	message: body,
	now: () => new Date('2026-07-07T12:02:00.000Z'),
});
expect(calls).toEqual([body]);
```

既存status再試行テストでは、呼ばれるとthrowするprocessorを渡す。

```ts
const failingProcessor: FeedJobProcessor = {
	async process() {
		throw new Error('processor should not run on status retry');
	},
};
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm --filter pipeline exec vitest run src/consumer.test.ts`

Expected: FAIL。`ProcessFeedJobMessageDeps` がまだ `fetcher` を要求している。

- [ ] **Step 3: consumer実装をprocessor注入へ変更する**

`pipeline/src/consumer.ts` を次の構造へ変更する。

```ts
import { maybeFinalizeJob, writeFeedStatus } from './finalize';
import { type FeedJobMessage, type FeedJobStatus, type FeedStatus, jobStatusKey } from './jobState';
import { readJson, type BucketLike } from './storage';

export interface FeedJobProcessor {
	process(message: FeedJobMessage): Promise<FeedStatus>;
}

export interface ProcessFeedJobMessageDeps {
	bucket: BucketLike;
	processor: FeedJobProcessor;
	message: FeedJobMessage;
	now(): Date;
}

export async function processFeedJobMessage({
	bucket,
	processor,
	message,
	now,
}: ProcessFeedJobMessageDeps): Promise<void> {
	const existingStatus = await readJson<FeedJobStatus>(
		bucket,
		jobStatusKey(message.jobId, message.target.id),
	);
	if (existingStatus) {
		await maybeFinalizeJob({ bucket, jobId: message.jobId });
		return;
	}

	const status = await processor.process(message);
	const jobStatus: FeedJobStatus = {
		...status,
		jobId: message.jobId,
		finishedAt: now().toISOString(),
	};

	await writeFeedStatus({ bucket, status: jobStatus });
	await maybeFinalizeJob({ bucket, jobId: message.jobId });
}
```

- [ ] **Step 4: index.tsをContainer dispatcherへつなぐ**

`pipeline/src/index.ts` のQueue handlerを変更する。`scheduled()` 側の `withOdptConsumerKey(fetch, env.ODPT_CONSUMER_KEY)` はODPT version解決のため維持する。

```ts
import { createContainerResolver, dispatchFeedToContainer } from './containerDispatcher';
import { processFeedJobMessage } from './consumer';
```

Queue handler内を次の形にする。

```ts
async queue(batch: MessageBatch<FeedJobMessage>, env: Env): Promise<void> {
	const bucket = toBucketLike(env.DATA_BUCKET);
	const resolver = createContainerResolver(env.FEED_PROCESSOR_CONTAINER);
	for (const message of batch.messages) {
		try {
			await processFeedJobMessage({
				bucket,
				processor: {
					process: async (body) => dispatchFeedToContainer({ resolver, message: body }),
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
}
```

- [ ] **Step 5: consumerテストと型チェックを通す**

Run: `pnpm --filter pipeline exec vitest run src/consumer.test.ts`

Expected: PASS。

Run: `pnpm --filter pipeline check`

Expected: PASS。

- [ ] **Step 6: 回帰テストを通す**

Run: `pnpm --filter pipeline test`

Expected: PASS。

- [ ] **Step 7: コミット**

```bash
git add pipeline/src/consumer.ts pipeline/src/consumer.test.ts pipeline/src/index.ts
git commit -m "feat(pipeline): Queue consumerをContainer委譲へ切り替え"
```

---

### Task 8: ドキュメントとCloudflare検証を更新する

**Files:**
- Modify: `pipeline/README.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: 実装済みContainer pipeline
- Produces: Containers前提の検証手順と運用確認手順

- [ ] **Step 1: pipeline READMEを更新する**

`pipeline/README.md` に次の節を追加する。

````md
## Container processing

Queue consumerはGTFS変換を直接実行せず、Cloudflare Containersの `FeedProcessorContainer` へ1フィード単位で処理を委譲する。Containerは `gtfs-core` で変換し、outbound handler経由でR2へ `feeds/<feedId>/...` を直接書く。Workerへ戻す値は小さな `FeedStatus` のみ。

ローカルでContainersを含めて動かすにはDockerが必要。DockerなしでWorker側の単体テストだけ実行する場合は、`pnpm --filter pipeline test` と `pnpm --filter pipeline check` を使う。

検証コマンド:

```bash
pnpm --filter pipeline test
pnpm --filter pipeline check
pnpm --filter pipeline cf:types
pnpm --filter pipeline cf:check
```

本番初回投入後は `pipeline/jobs/current.json`、`pipeline/jobs/<jobId>/summary.json`、Queues DLQ、Cloudflare logsを確認する。DLQに落ちたメッセージがある場合、`feeds.json` は差し替わらず前回公開版を維持する。
````

- [ ] **Step 2: root READMEを更新する**

`README.md` のPipeline説明を、Worker変換からContainer変換へ更新する。

```md
`pipeline/` は Cloudflare Workers Cron + Queues + Containers + R2 で GTFS を月次変換する。Cronは対象フィード一覧を作ってQueueへ投入し、Queue consumerはContainerへ1フィード単位で変換を委譲する。ContainerはR2 outbound handler経由で成果物を書き込み、全statusが揃った時だけ `feeds.json` を差し替える。
```

- [ ] **Step 3: 全体検証を通す**

Run: `pnpm --filter pipeline test`

Expected: PASS。

Run: `pnpm --filter pipeline check`

Expected: PASS。

Run: `pnpm --filter pipeline cf:types`

Expected: PASS。

Run: `pnpm --filter pipeline cf:check`

Expected: PASS。Docker daemonが必要な環境エラーが出た場合は、エラーメッセージを記録し、`test` と `check` が通っている状態で止める。

- [ ] **Step 4: 最終状態を確認する**

Run: `git status --short`

Expected: 実装対象ファイルだけが変更されている。意図しないアプリ側ファイル変更が無い。

- [ ] **Step 5: コミット**

```bash
git add README.md pipeline/README.md
git commit -m "docs(pipeline): Containers変換の運用手順を追加"
```

---

## Self-Review Checklist

- Spec coverage:
  - Queue維持: Task 7
  - Container委譲: Task 5, Task 6, Task 7
  - ContainerがR2へ直接書く: Task 2, Task 3, Task 4
  - R2 S3認証情報をContainerへ渡さない: Task 2, Task 5
  - 公開キー/schema維持: Task 4, Task 7
  - 全status後の `feeds.json` 差し替え維持: Task 7
  - 安定優先の並列度: Task 5
  - `Container` 継承classの例外: Task 5
  - Queue consumer 15分制限: Task 1, Task 6
  - ODPTキーをContainer runtime envへ渡す: Task 4, Task 5
- Placeholder scan: 禁止語句や未決定事項を含めない。
- Type consistency:
  - `ProcessFeedRequest` は `FeedJobMessage` を拡張する。
  - `ProcessFeedResponse` は `FeedStatus`。
  - `dispatchFeedToContainer()` は `FeedStatus` を返す。
  - `processFeedJobMessage()` は `FeedJobProcessor` を受け取る。
