# HODA CKAN Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HODA の `gtfs-data` CKAN package から直接 ZIP 配布の公共交通 GTFS を取得し、既存パイプラインとアプリに `hoda` データソースとして統合する。

**Architecture:** 既存の `FeedSource` 境界は維持し、CKAN package API を `FeedTarget[]` に変換する深いモジュール `pipeline/src/sources/ckanPackage.ts` を追加する。HODA 固有値は Worker のソース設定に閉じ込め、R2 公開形式とアプリの `/data/*` 契約は変えない。

**Tech Stack:** TypeScript, Cloudflare Workers, Vitest, SvelteKit, pnpm workspace.

## Global Constraints

- 応答・説明・ドキュメント・コミットメッセージ・コードコメントは日本語で書く。コミットメッセージは Conventional Commits の type は英語のまま、説明文を日本語にする。
- TypeScript で `any` 型と `unknown` 型を使わない。
- TypeScript の `class` は必要な場合だけ使う。この実装では使わない。
- 公開インターフェースを増やす場合は、実際に外部から使うものだけにする。
- HODA はバスだけに限定せず、フェリーと市電の GTFS も対象に含める。
- URL 空、外部ページリンク、HTMLリンクだけの HODA リソースは初回対象外にする。
- HODA は `prefId: 1` として北海道に紐づける。
- 検証コマンドは `pnpm --filter pipeline test`、`pnpm --filter pipeline check`、`pnpm --filter app check` を使う。

---

## File Structure

- Create: `pipeline/src/sources/ckanPackage.ts`
  - CKAN `package_show` API の取得、レスポンス検証、対象リソース判定、`FeedTarget` 変換を担当する。
- Create: `pipeline/src/sources/ckanPackage.test.ts`
  - HODA 形式の CKAN fixture からの抽出、除外、エラー処理、`versionId` を検証する。
- Modify: `pipeline/src/sources/types.ts`
  - `SourceId` に `'hoda'` を追加する。
- Modify: `pipeline/src/jobProducer.ts`
  - `Record<SourceId, number>` の初期値に `hoda` を追加する。
- Modify: `pipeline/src/jobProducer.test.ts`
  - `hoda` ソースの件数集計を検証する。
- Modify: `pipeline/src/finalize.test.ts`
  - `hoda` を含む `JobManifest.sources` / `JobSummary.sources` を検証する。
- Modify: `pipeline/src/consumer.test.ts`
  - テスト用 manifest の `sources` に `hoda: 0` を追加する。
- Modify: `pipeline/src/index.ts`
  - HODA CKAN package source を scheduled のソース一覧に追加する。
- Modify: `app/src/lib/Controls.svelte`
  - HODA 出典クレジットを追加し、運行中件数の単位を公共交通向けに変更する。
- Modify: `app/src/routes/+page.svelte`
  - 空状態の「バス」文言を公共交通向けに変更する。
- Modify: `app/src/lib/StopTimetable.svelte`
  - 「バス停」文言を停留所向けに変更する。

---

### Task 1: SourceId と件数集計を HODA に対応させる

**Files:**
- Modify: `pipeline/src/sources/types.ts`
- Modify: `pipeline/src/jobProducer.ts`
- Modify: `pipeline/src/jobProducer.test.ts`
- Modify: `pipeline/src/finalize.test.ts`
- Modify: `pipeline/src/consumer.test.ts`

**Interfaces:**
- Consumes: existing `FeedSource`, `FeedTarget`, `JobManifest`, `JobSummary`.
- Produces: `SourceId = 'gtfs-data.jp' | 'odpt' | 'hoda'`; all `Record<SourceId, number>` values include `hoda`.

- [ ] **Step 1: Write the failing source-count test**

Modify `pipeline/src/jobProducer.test.ts`.

```ts
import type { FeedSource, FeedTarget, SourceId } from './sources/types';

function target(id: string, source: SourceId): FeedTarget {
	return {
		id,
		name: id,
		orgName: 'org',
		license: 'CC BY 4.0',
		fromDate: '',
		toDate: '',
		source,
		versionId: `version-${id}`,
		zipUrl: `https://example.com/${id}.zip`,
	};
}
```

In the first test, replace the single source setup with:

```ts
const source: FeedSource = {
	sourceId: 'gtfs-data.jp',
	listTargets: async () => [target('a', 'gtfs-data.jp'), target('b', 'gtfs-data.jp')],
};
const hodaSource: FeedSource = {
	sourceId: 'hoda',
	listTargets: async () => [target('hoda-feed', 'hoda')],
};
const result = await createFeedJob({
	bucket,
	queue,
	fetcher: fetch,
	sources: [source, hodaSource],
	now: () => new Date('2026-07-07T12:00:00.000Z'),
	randomBytes: () => new Uint8Array([0xa1, 0xb2, 0xc3]),
});
expect(result).toEqual({ status: 'queued', jobId: '20260707T120000Z-a1b2c3', total: 3 });
```

Then update the expectations in that test:

```ts
expect(manifest.targets.map((t) => t.id)).toEqual(['a', 'b', 'hoda-feed']);
expect(manifest.sources).toEqual({ 'gtfs-data.jp': 2, odpt: 0, hoda: 1 });
expect(queue.batches[0].map((m) => m.body.target.id)).toEqual(['a', 'b', 'hoda-feed']);
```

- [ ] **Step 2: Run the failing test**

Run:

```sh
pnpm --filter pipeline exec vitest run src/jobProducer.test.ts
```

Expected: FAIL with a TypeScript error or assertion failure showing that `'hoda'` is not yet part of `SourceId` or the source counts.

- [ ] **Step 3: Add `hoda` to source types and counts**

Modify `pipeline/src/sources/types.ts`.

```ts
/** フィードの取得元レジストリ */
export type SourceId = 'gtfs-data.jp' | 'odpt' | 'hoda';
```

Modify `pipeline/src/jobProducer.ts`.

```ts
const counts: Record<SourceId, number> = { 'gtfs-data.jp': 0, odpt: 0, hoda: 0 };
```

- [ ] **Step 4: Update tests that construct source-count records**

Modify `pipeline/src/consumer.test.ts`.

```ts
sources: { 'gtfs-data.jp': 1, odpt: 0, hoda: 0 },
```

Modify `pipeline/src/finalize.test.ts`.

```ts
import type { FeedTarget, SourceId } from './sources/types';

function target(id: string, source: SourceId, prefId?: number | null): FeedTarget {
	return {
		id,
		name: id,
		orgName: 'org',
		license: null,
		fromDate: '',
		toDate: '',
		source,
		versionId: `v-${id}`,
		zipUrl: `https://example.com/${id}.zip`,
		prefId,
	};
}
```

In the "全status完了時だけfeeds.json/summary/currentを書き、孤児掃除する" test, use a HODA target:

```ts
const targets = [
	target('a', 'gtfs-data.jp', 13),
	target('b', 'odpt', null),
	target('c', 'hoda', 1),
];
const manifest: JobManifest = {
	jobId: 'job-1',
	createdAt: '2026-07-07T12:00:00.000Z',
	targets,
	sources: { 'gtfs-data.jp': 1, odpt: 1, hoda: 1 },
	previousFeedsGeneratedAt: '2026-06-01T00:00:00.000Z',
};
```

Add the third status before finalize:

```ts
bucket.store.set(jobStatusKey('job-1', 'c'), JSON.stringify(status(targets[2], 'updated')));
```

Update expectations in that test:

```ts
expect(index.feeds.map((feed) => feed.id)).toEqual(['a', 'b', 'c']);
expect(index.feeds.map((f) => (f as { prefId?: number | null }).prefId)).toEqual([
	13,
	null,
	1,
]);
expect(summary).toEqual({
	jobId: 'job-1',
	generatedAt: '2026-07-07T12:00:00.000Z',
	total: 3,
	updated: 2,
	unchanged: 0,
	error: 1,
	sources: { 'gtfs-data.jp': 1, odpt: 1, hoda: 1 },
	published: true,
	prefIdMissing: 1,
});
```

For every other `sources` literal in `pipeline/src/finalize.test.ts`, add `hoda: 0`.

- [ ] **Step 5: Run task tests**

Run:

```sh
pnpm --filter pipeline exec vitest run src/jobProducer.test.ts src/finalize.test.ts src/consumer.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add pipeline/src/sources/types.ts pipeline/src/jobProducer.ts pipeline/src/jobProducer.test.ts pipeline/src/finalize.test.ts pipeline/src/consumer.test.ts
git commit -m "feat(pipeline): HODAソースIDを追加"
```

---

### Task 2: CKAN package source を追加する

**Files:**
- Create: `pipeline/src/sources/ckanPackage.ts`
- Create: `pipeline/src/sources/ckanPackage.test.ts`

**Interfaces:**
- Consumes: `SourceId`, `FeedSource`, `FeedTarget`.
- Produces: `createCkanPackageSource(config: CkanPackageSourceConfig): FeedSource`.

- [ ] **Step 1: Write the failing CKAN source tests**

Create `pipeline/src/sources/ckanPackage.test.ts`.

```ts
import { describe, expect, it } from 'vitest';
import { createCkanPackageSource } from './ckanPackage';

const HODA_RESPONSE = {
	success: true,
	result: {
		title: '公共交通GTFSデータ(Public Transport GTFS Data)',
		license_title: 'クリエイティブ・コモンズ 表示',
		organization: { title: '地方創生モビリティコンソーシアム' },
		resources: [
			{
				id: 'c84abf64-f7ba-4d22-8cc1-acac7adbdc6f',
				name: '網走バス(Abashiri Bus)',
				format: 'ZIP',
				mimetype: 'application/zip',
				state: 'active',
				url: 'https://ckan.hoda.jp/dataset/24/resource/c84abf64-f7ba-4d22-8cc1-acac7adbdc6f/download/abashiri_bus.zip',
				last_modified: '2026-07-01T00:00:06.572591',
				revision_id: 'rev-bus',
				size: 410309,
			},
			{
				id: '16a31295-1709-4e5e-abcf-fa17ae7853b7',
				name: '青函フェリー(Seikan Ferry)',
				format: 'ZIP',
				mimetype: 'application/zip',
				state: 'active',
				url: 'https://ckan.hoda.jp/dataset/24/resource/16a31295-1709-4e5e-abcf-fa17ae7853b7/download/seikan_ferry.zip',
				last_modified: '2021-03-23T04:12:48.131468',
				revision_id: 'rev-ferry',
				size: 5328,
			},
			{
				id: 'cf1835a7-6a0e-4483-a6de-6a8dc1f71aca',
				name: '函館市電 運行に関するデータ（GTFS-JP）',
				format: 'ZIP',
				mimetype: 'application/zip',
				state: 'active',
				url: 'https://ckan.hoda.jp/dataset/24/resource/cf1835a7-6a0e-4483-a6de-6a8dc1f71aca/download/hakodate_tram.zip',
				last_modified: null,
				revision_id: 'rev-tram',
				size: 10240,
			},
			{
				id: 'b9e5c644-23e1-44c3-bad0-4ce364eb6cb6',
				name: '観光データ(sightseeing_spot)',
				format: 'ZIP',
				mimetype: 'application/zip',
				state: 'active',
				url: 'https://ckan.hoda.jp/dataset/24/resource/b9e5c644-23e1-44c3-bad0-4ce364eb6cb6/download/sightseeing.zip',
				last_modified: '2026-01-01T00:00:00.000000',
				revision_id: 'rev-sightseeing',
				size: 2048,
			},
			{
				id: 'external-page',
				name: '十勝バス(Tokachi Bus)',
				format: 'ZIP',
				mimetype: 'application/zip',
				state: 'active',
				url: 'https://www.tokachibus.jp/rosenbus/opendata/',
				last_modified: '2021-11-24T07:09:30.851725',
				revision_id: 'rev-external',
				size: 1284210,
			},
			{
				id: 'blank-url',
				name: '美唄市コミュニティ',
				format: '',
				mimetype: null,
				state: 'active',
				url: '',
				last_modified: null,
				revision_id: 'rev-blank',
				size: null,
			},
			{
				id: 'html-link',
				name: '北海道北見バス(Hokkaido Kitami Bus)',
				format: 'HTML',
				mimetype: 'text/html',
				state: 'active',
				url: 'https://ckan.hoda.jp/dataset/24/resource/html-link/download/download.html',
				last_modified: '2026-07-02T02:09:52.733814',
				revision_id: 'rev-html',
				size: 34505,
			},
			{
				id: 'inactive',
				name: '無効リソース',
				format: 'ZIP',
				mimetype: 'application/zip',
				state: 'deleted',
				url: 'https://ckan.hoda.jp/dataset/24/resource/inactive/download/inactive.zip',
				last_modified: '2026-01-01T00:00:00.000000',
				revision_id: 'rev-inactive',
				size: 1,
			},
		],
	},
};

function jsonFetcher(body: object, status = 200, calls: string[] = []): typeof fetch {
	const impl = async (input: RequestInfo | URL): Promise<Response> => {
		calls.push(String(input));
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' },
		});
	};
	return impl as typeof fetch;
}

function hodaSource() {
	return createCkanPackageSource({
		sourceId: 'hoda',
		baseUrl: 'https://ckan.hoda.jp',
		packageId: 'gtfs-data',
		prefId: 1,
		excludedNamePatterns: [/観光データ/],
	});
}

describe('createCkanPackageSource', () => {
	it('HODAの直接ZIP公共交通GTFSをFeedTargetに変換する', async () => {
		const calls: string[] = [];
		const targets = await hodaSource().listTargets(jsonFetcher(HODA_RESPONSE, 200, calls));

		expect(calls).toEqual(['https://ckan.hoda.jp/api/3/action/package_show?id=gtfs-data']);
		expect(targets.map((target) => target.id)).toEqual([
			'hoda~c84abf64-f7ba-4d22-8cc1-acac7adbdc6f',
			'hoda~16a31295-1709-4e5e-abcf-fa17ae7853b7',
			'hoda~cf1835a7-6a0e-4483-a6de-6a8dc1f71aca',
		]);
		expect(targets[0]).toEqual({
			id: 'hoda~c84abf64-f7ba-4d22-8cc1-acac7adbdc6f',
			name: '網走バス(Abashiri Bus)',
			orgName: '地方創生モビリティコンソーシアム',
			license: 'クリエイティブ・コモンズ 表示',
			fromDate: '',
			toDate: '',
			source: 'hoda',
			versionId:
				'c84abf64-f7ba-4d22-8cc1-acac7adbdc6f:2026-07-01T00:00:06.572591:rev-bus:410309',
			zipUrl:
				'https://ckan.hoda.jp/dataset/24/resource/c84abf64-f7ba-4d22-8cc1-acac7adbdc6f/download/abashiri_bus.zip',
			prefId: 1,
		});
		expect(targets[1].name).toContain('フェリー');
		expect(targets[2].name).toContain('市電');
		expect(targets[2].versionId).toBe(
			'cf1835a7-6a0e-4483-a6de-6a8dc1f71aca::rev-tram:10240',
		);
	});

	it('CKAN API失敗をソース一覧失敗としてthrowする', async () => {
		await expect(hodaSource().listTargets(jsonFetcher({ success: false }))).rejects.toThrow(
			'ckan package fetch failed: success false',
		);
		await expect(hodaSource().listTargets(jsonFetcher({ success: true }, 503))).rejects.toThrow(
			'ckan package fetch failed: 503',
		);
		await expect(
			hodaSource().listTargets(jsonFetcher({ success: true, result: { title: 'broken' } })),
		).rejects.toThrow('ckan package response malformed');
	});
});
```

- [ ] **Step 2: Run the failing CKAN source test**

Run:

```sh
pnpm --filter pipeline exec vitest run src/sources/ckanPackage.test.ts
```

Expected: FAIL because `./ckanPackage` does not exist.

- [ ] **Step 3: Implement `ckanPackage.ts`**

Create `pipeline/src/sources/ckanPackage.ts`.

```ts
import type { FeedSource, FeedTarget, SourceId } from './types';

export interface CkanPackageSourceConfig {
	sourceId: SourceId;
	baseUrl: string;
	packageId: string;
	prefId?: number | null;
	excludedNamePatterns?: RegExp[];
}

interface CkanPackageResponse {
	success: boolean;
	result?: CkanPackage;
	error?: { message?: string };
}

interface CkanPackage {
	title?: string;
	license_title?: string | null;
	organization?: { title?: string };
	resources?: CkanResource[];
}

interface CkanResource {
	id?: string;
	name?: string;
	format?: string | null;
	mimetype?: string | null;
	state?: string;
	url?: string | null;
	last_modified?: string | null;
	revision_id?: string | null;
	size?: number | null;
}

function packageShowUrl(baseUrl: string, packageId: string): string {
	const url = new URL('/api/3/action/package_show', baseUrl);
	url.searchParams.set('id', packageId);
	return url.toString();
}

function cleanText(value: string | null | undefined): string {
	return (value ?? '').trim();
}

function normalized(value: string | null | undefined): string {
	return cleanText(value).toLowerCase();
}

function isZipResource(resource: CkanResource): boolean {
	const format = normalized(resource.format);
	const mimetype = normalized(resource.mimetype);
	return format === 'zip' || mimetype.includes('zip');
}

function isDirectPackageZip(resourceUrl: string | null | undefined, baseUrl: string): boolean {
	const rawUrl = cleanText(resourceUrl);
	if (!rawUrl) return false;
	try {
		const url = new URL(rawUrl);
		const base = new URL(baseUrl);
		return (
			url.protocol === base.protocol &&
			url.hostname === base.hostname &&
			url.pathname.includes('/download/') &&
			url.pathname.toLowerCase().endsWith('.zip')
		);
	} catch {
		return false;
	}
}

function isExcluded(resource: CkanResource, patterns: RegExp[] | undefined): boolean {
	const name = cleanText(resource.name);
	return patterns?.some((pattern) => pattern.test(name)) ?? false;
}

function isTargetResource(resource: CkanResource, config: CkanPackageSourceConfig): boolean {
	return (
		resource.state === 'active' &&
		Boolean(resource.id) &&
		isZipResource(resource) &&
		isDirectPackageZip(resource.url, config.baseUrl) &&
		!isExcluded(resource, config.excludedNamePatterns)
	);
}

function versionId(resource: CkanResource): string {
	return [
		cleanText(resource.id),
		cleanText(resource.last_modified),
		cleanText(resource.revision_id),
		resource.size == null ? '' : String(resource.size),
	].join(':');
}

function targetFromResource(
	resource: CkanResource,
	pkg: CkanPackage,
	config: CkanPackageSourceConfig,
): FeedTarget | null {
	if (!isTargetResource(resource, config) || !resource.id || !resource.url) return null;
	return {
		id: `${config.sourceId}~${resource.id}`,
		name: cleanText(resource.name) || resource.id,
		orgName: cleanText(pkg.organization?.title) || cleanText(pkg.title) || config.sourceId,
		license: cleanText(pkg.license_title) || null,
		fromDate: '',
		toDate: '',
		source: config.sourceId,
		versionId: versionId(resource),
		zipUrl: resource.url,
		prefId: config.prefId ?? null,
	};
}

/** CKAN package_show APIのリソース一覧をFeedSourceへ適合させる */
export function createCkanPackageSource(config: CkanPackageSourceConfig): FeedSource {
	return {
		sourceId: config.sourceId,
		async listTargets(fetcher) {
			const res = await fetcher(packageShowUrl(config.baseUrl, config.packageId));
			if (!res.ok) throw new Error(`ckan package fetch failed: ${res.status}`);
			const body = (await res.json()) as CkanPackageResponse;
			if (!body.success) {
				throw new Error(`ckan package fetch failed: ${body.error?.message ?? 'success false'}`);
			}
			if (!body.result || !Array.isArray(body.result.resources)) {
				throw new Error('ckan package response malformed');
			}
			return body.result.resources
				.map((resource) => targetFromResource(resource, body.result as CkanPackage, config))
				.filter((target): target is FeedTarget => target !== null);
		},
	};
}
```

- [ ] **Step 4: Run CKAN source test**

Run:

```sh
pnpm --filter pipeline exec vitest run src/sources/ckanPackage.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add pipeline/src/sources/ckanPackage.ts pipeline/src/sources/ckanPackage.test.ts
git commit -m "feat(pipeline): CKAN packageソースを追加"
```

---

### Task 3: HODA を Worker とアプリ表示に接続する

**Files:**
- Modify: `pipeline/src/index.ts`
- Modify: `app/src/lib/Controls.svelte`
- Modify: `app/src/routes/+page.svelte`
- Modify: `app/src/lib/StopTimetable.svelte`

**Interfaces:**
- Consumes: `createCkanPackageSource(config: CkanPackageSourceConfig): FeedSource` from Task 2.
- Produces: scheduled pipeline includes HODA targets; app credits display `北海道オープンデータプラットフォーム(HODA)`.

- [ ] **Step 1: Add HODA integration before implementation checks**

Modify `pipeline/src/index.ts` imports.

```ts
import { createCkanPackageSource } from './sources/ckanPackage';
```

Add the HODA source to the `sources` array after ODPT:

```ts
createCkanPackageSource({
	sourceId: 'hoda',
	baseUrl: 'https://ckan.hoda.jp',
	packageId: 'gtfs-data',
	prefId: 1,
	excludedNamePatterns: [/観光データ/],
}),
```

- [ ] **Step 2: Update app source credit and count unit**

Modify `app/src/lib/Controls.svelte`.

```ts
const SOURCE_CREDITS: Record<string, string> = {
	'gtfs-data.jp': 'GTFSデータリポジトリ(gtfs-data.jp)',
	odpt: '公共交通オープンデータセンター(ODPT)',
	hoda: '北海道オープンデータプラットフォーム(HODA)',
};
```

Replace the visible count unit:

```svelte
<span class="ml-auto text-sm text-mi-slate-600"
	>運行中: <span class="font-bold text-mi-ember-500">{busCount}</span>件</span
>
```

- [ ] **Step 3: Update public-transport wording**

Modify `app/src/routes/+page.svelte`.

```svelte
この日時に運行中の公共交通はありません(日付がダイヤの有効期間外の可能性があります)
```

Modify `app/src/lib/StopTimetable.svelte`.

```svelte
この停留所を通る運行中の路線は、現在レイヤで表示されていません。<br
/>左の「路線レイヤ」から表示をオンにしてください。
```

- [ ] **Step 4: Run integration checks**

Run:

```sh
pnpm --filter pipeline check
pnpm --filter app check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add pipeline/src/index.ts app/src/lib/Controls.svelte app/src/routes/+page.svelte app/src/lib/StopTimetable.svelte
git commit -m "feat(pipeline): HODA CKANソースを接続"
```

---

### Task 4: 全体検証と差分確認

**Files:**
- No planned file edits.

**Interfaces:**
- Consumes: all outputs from Tasks 1-3.
- Produces: verified implementation ready for review.

- [ ] **Step 1: Run full pipeline tests**

Run:

```sh
pnpm --filter pipeline test
```

Expected: PASS.

- [ ] **Step 2: Run TypeScript checks**

Run:

```sh
pnpm --filter pipeline check
pnpm --filter app check
```

Expected: PASS.

- [ ] **Step 3: Inspect git diff for accidental scope creep**

Run:

```sh
git diff --stat HEAD
git diff -- pipeline/src/sources/types.ts pipeline/src/jobProducer.ts pipeline/src/sources/ckanPackage.ts pipeline/src/index.ts app/src/lib/Controls.svelte app/src/routes/+page.svelte app/src/lib/StopTimetable.svelte
```

Expected: Changes are limited to HODA source support, source counts, CKAN extraction tests, and public-transport wording.

- [ ] **Step 4: Decide completion state**

If Step 1 or Step 2 fails, do not create a verification commit. Return to the task that introduced the failing file and repeat that task's test cycle before running Task 4 again.

Expected: no uncommitted code changes remain after successful verification.
