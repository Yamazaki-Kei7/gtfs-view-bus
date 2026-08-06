# 広島県バス協会(bus-kyo)GTFSデータソース追加 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 広島県バス協会のオープンデータ(17事業者・CC0)を静的マニフェスト方式で取り込み、`prefId=34` として R2 に公開してアプリの都道府県ピッカーで広島を表示できるようにする。

**Architecture:** 既存の `FeedSource` 境界に、リポジトリ内の固定 JSON マニフェストを `FeedTarget[]` へ写像する `createBusKyoSource()` を1つ追加する。差分検出キー `versionId` は `''`(常に再処理)。あわせて `SourceId` を単一情報源(`SOURCE_IDS`)化し、`containerProtocol.isSourceId` が `'hoda'` を許可していない既存バグを同時に修正する。

**Tech Stack:** TypeScript / Cloudflare Workers + Containers / SvelteKit / Vitest / pnpm workspace

設計書: `docs/superpowers/specs/2026-08-06-hiroshima-bus-kyo-source-design.md`

---

## 事前準備

このリポジトリのデフォルト shell は Node 16 のため、**各セッションの最初に必ず** 次を実行して Node 22 を有効化する(これをしないと pnpm/vitest が動かない):

```sh
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
```

作業ブランチは `feat/bus-kyo-source`(設計書コミット済み)。

## ファイル構成

新規:

- `pipeline/src/sources/busKyoManifest.json` — 17事業者の固定リスト `{ key, name, zipUrl }[]`
- `pipeline/src/sources/busKyo.ts` — `createBusKyoSource()`。マニフェストを `FeedTarget[]` へ写像
- `pipeline/src/sources/busKyo.test.ts` — 写像の単体テスト

変更:

- `pipeline/src/sources/types.ts` — `SOURCE_IDS` 追加、`SourceId` を派生型化(`'bus-kyo'` を含める)
- `pipeline/src/containerProtocol.ts` — `isSourceId` を `SOURCE_IDS` から導出(既存バグ修正)
- `pipeline/src/jobProducer.ts` — `counts` 初期値に `'bus-kyo': 0`
- `pipeline/src/index.ts` — `sources` 配列に `createBusKyoSource()`
- `app/src/lib/Controls.svelte` — `SOURCE_CREDITS` に `'bus-kyo'`
- テスト4件(`containerProtocol.test.ts` / `jobProducer.test.ts` / `finalize.test.ts` / `consumer.test.ts`)の `Record<SourceId, number>` リテラルへ `'bus-kyo': 0` を反映

---

## Task 1: `SourceId` の単一情報源化と `isSourceId` バグ修正

`SourceId` を配列 `SOURCE_IDS` から導出し、`containerProtocol.isSourceId` がその配列を唯一の真実として全メンバーを許可するようにする。これにより現状 `'hoda'` フィードが Container 応答パースで全滅する既存バグを直し、`'bus-kyo'` 追加後の再発も防ぐ。

**Files:**
- Modify: `pipeline/src/sources/types.ts:2`
- Modify: `pipeline/src/containerProtocol.ts:17-19`
- Modify: `pipeline/src/jobProducer.ts:54`
- Test: `pipeline/src/containerProtocol.test.ts`
- Modify(テスト期待値): `pipeline/src/jobProducer.test.ts:74`, `pipeline/src/finalize.test.ts:93,119,148`, `pipeline/src/consumer.test.ts:84`

- [ ] **Step 1: 回帰テストを追加(失敗させる)**

`pipeline/src/containerProtocol.test.ts` の `describe('containerProtocol', ...)` 内、末尾の `it('不正なstatus値はrejectする', ...)` の**後**に次を追加する:

```ts
	it('hoda / bus-kyo を含む全SourceIdのsourceを受理する', () => {
		for (const source of ['gtfs-data.jp', 'odpt', 'hoda', 'bus-kyo'] as const) {
			const status = parseFeedStatusResponse(
				JSON.stringify({
					id: 'feed-1',
					name: 'フィード1',
					orgName: '事業者',
					license: null,
					fromDate: '',
					toDate: '',
					source,
					status: 'updated',
				}),
			);
			expect(status.source).toBe(source);
		}
	});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run:
```sh
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
pnpm --filter pipeline exec vitest run src/containerProtocol.test.ts
```
Expected: FAIL — `container status response malformed: source`(`'hoda'` で throw する)

- [ ] **Step 3: `types.ts` を単一情報源化して `'bus-kyo'` を追加**

`pipeline/src/sources/types.ts` の1〜2行目を次に置き換える:

```ts
/** フィードの取得元レジストリ。ここが SourceId の唯一の真実。追加時はこの配列だけ更新する */
export const SOURCE_IDS = ['gtfs-data.jp', 'odpt', 'hoda', 'bus-kyo'] as const;
export type SourceId = (typeof SOURCE_IDS)[number];
```

(以降の `FeedTarget` / `FeedSource` 定義はそのまま)

- [ ] **Step 4: `containerProtocol.isSourceId` を配列から導出**

`pipeline/src/containerProtocol.ts` の import 文(2行目)を次に変更:

```ts
import { SOURCE_IDS, type SourceId } from './sources/types';
```

`isSourceId`(17〜19行目)を次に置き換える:

```ts
function isSourceId(value: string | undefined): value is SourceId {
	return value !== undefined && (SOURCE_IDS as readonly string[]).includes(value);
}
```

- [ ] **Step 5: `jobProducer.ts` の counts 初期値に `'bus-kyo': 0` を追加**

`pipeline/src/jobProducer.ts:54` を次に置き換える:

```ts
	const counts: Record<SourceId, number> = { 'gtfs-data.jp': 0, odpt: 0, hoda: 0, 'bus-kyo': 0 };
```

- [ ] **Step 6: 既存テストの `Record<SourceId, number>` リテラルへ反映**

`pipeline/src/jobProducer.test.ts:74` を置き換える:
```ts
		expect(manifest.sources).toEqual({ 'gtfs-data.jp': 2, odpt: 0, hoda: 1, 'bus-kyo': 0 });
```

`pipeline/src/finalize.test.ts` には `sources:` リテラルが3箇所ある。`hoda: 0` の1箇所(93行目付近)と、**完全に同一文字列**の `hoda: 1` の2箇所(119行目付近の `JobManifest` と 148行目付近の `expect(summary).toEqual` 内)。

93行目付近 `sources: { 'gtfs-data.jp': 1, odpt: 1, hoda: 0 },` を置き換える:
```ts
			sources: { 'gtfs-data.jp': 1, odpt: 1, hoda: 0, 'bus-kyo': 0 },
```

`sources: { 'gtfs-data.jp': 1, odpt: 1, hoda: 1 },` は119・148行目付近に**2箇所**あり、**両方**を次に置き換える(Edit ツールなら `replace_all: true`):
```ts
			sources: { 'gtfs-data.jp': 1, odpt: 1, hoda: 1, 'bus-kyo': 0 },
```

`pipeline/src/consumer.test.ts:84` を置き換える:
```ts
			sources: { 'gtfs-data.jp': 1, odpt: 0, hoda: 0, 'bus-kyo': 0 },
```

- [ ] **Step 7: テストと型チェックを実行して成功を確認**

Run:
```sh
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
pnpm --filter pipeline test
pnpm --filter pipeline check
```
Expected: すべて PASS。型チェックで `Record<SourceId, number>` の欠落エラーが無いこと。

- [ ] **Step 8: コミット**

```sh
git add pipeline/src/sources/types.ts pipeline/src/containerProtocol.ts pipeline/src/jobProducer.ts \
  pipeline/src/containerProtocol.test.ts pipeline/src/jobProducer.test.ts \
  pipeline/src/finalize.test.ts pipeline/src/consumer.test.ts
git commit -m "fix(pipeline): isSourceIdの全SourceId対応とSourceId単一情報源化

containerProtocol.isSourceIdが'hoda'を許可しておらずContainer応答パースで
hoda/bus-kyoフィードが全滅する既存バグを修正。SOURCE_IDS配列を唯一の真実に
してSourceIdを派生させ、'bus-kyo'を追加。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0124ys6pRc8MTWT3D7Ypg4ME"
```

---

## Task 2: `createBusKyoSource()` とマニフェスト

17事業者の固定マニフェストと、それを `FeedTarget[]` へ写像するソースを追加する。ネットワークアクセスは無い(zip は後段の `feedProcessor` が取得する)。

**Files:**
- Create: `pipeline/src/sources/busKyoManifest.json`
- Create: `pipeline/src/sources/busKyo.ts`
- Test: `pipeline/src/sources/busKyo.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`pipeline/src/sources/busKyo.test.ts` を新規作成:

```ts
import { describe, expect, it } from 'vitest';
import { createBusKyoSource } from './busKyo';

describe('createBusKyoSource', () => {
	it('マニフェストの17事業者をFeedTargetへ写像する', async () => {
		const targets = await createBusKyoSource().listTargets(fetch);
		expect(targets).toHaveLength(17);
	});

	it('先頭エントリ(広島電鉄)を規約どおりに写像する', async () => {
		const targets = await createBusKyoSource().listTargets(fetch);
		expect(targets[0]).toEqual({
			id: 'bus-kyo~hiroden',
			name: '広島電鉄',
			orgName: '広島電鉄',
			license: 'CC0',
			fromDate: '',
			toDate: '',
			source: 'bus-kyo',
			versionId: '',
			zipUrl: 'https://ajt-mobusta-gtfs.mcapps.jp/static/8/latest.zip',
			prefId: 34,
		});
	});

	it('全フィードが広島県(34)・CC0・source=bus-kyo・versionId空である', async () => {
		const targets = await createBusKyoSource().listTargets(fetch);
		for (const t of targets) {
			expect(t.prefId).toBe(34);
			expect(t.license).toBe('CC0');
			expect(t.source).toBe('bus-kyo');
			expect(t.versionId).toBe('');
			expect(t.id.startsWith('bus-kyo~')).toBe(true);
		}
	});

	it('idが一意である', async () => {
		const targets = await createBusKyoSource().listTargets(fetch);
		const ids = targets.map((t) => t.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run:
```sh
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
pnpm --filter pipeline exec vitest run src/sources/busKyo.test.ts
```
Expected: FAIL — `Cannot find module './busKyo'`

- [ ] **Step 3: マニフェスト JSON を作成**

`pipeline/src/sources/busKyoManifest.json` を新規作成:

```json
[
	{ "key": "hiroden", "name": "広島電鉄", "zipUrl": "https://ajt-mobusta-gtfs.mcapps.jp/static/8/latest.zip" },
	{ "key": "hiroshima-bus", "name": "広島バス", "zipUrl": "https://ajt-mobusta-gtfs.mcapps.jp/static/9/latest.zip" },
	{ "key": "hiroshima-kotsu", "name": "広島交通", "zipUrl": "https://ajt-mobusta-gtfs.mcapps.jp/static/10/latest.zip" },
	{ "key": "geiyo-bus", "name": "芸陽バス", "zipUrl": "https://ajt-mobusta-gtfs.mcapps.jp/static/11/latest.zip" },
	{ "key": "bihoku-kotsu", "name": "備北交通", "zipUrl": "https://ajt-mobusta-gtfs.mcapps.jp/static/12/latest.zip" },
	{ "key": "jrbus-chugoku", "name": "JRバス中国", "zipUrl": "https://ajt-mobusta-gtfs.mcapps.jp/static/15/latest.zip" },
	{ "key": "hd-nishi-hiroshima", "name": "エイチ・ディー西広島", "zipUrl": "https://ajt-mobusta-gtfs.mcapps.jp/static/13/latest.zip" },
	{ "key": "forble", "name": "フォーブル", "zipUrl": "https://ajt-mobusta-gtfs.mcapps.jp/static/14/latest.zip" },
	{ "key": "sasaki-kanko", "name": "ささき観光", "zipUrl": "https://ajt-mobusta-gtfs.mcapps.jp/static/17/latest.zip" },
	{ "key": "kure-seikatsu-bus", "name": "呉市生活バス", "zipUrl": "https://ajt-mobusta-gtfs.mcapps.jp/static/18/latest.zip" },
	{ "key": "hatsukaichi-jishu", "name": "廿日市市自主運行バス", "zipUrl": "https://ajt-mobusta-gtfs.mcapps.jp/static/19/latest.zip" },
	{ "key": "asahi-kotsu", "name": "朝日交通", "zipUrl": "https://ajt-mobusta-gtfs.mcapps.jp/static/54/latest.zip" },
	{ "key": "onomichi-bus", "name": "おのみちバス", "zipUrl": "https://ajt-mobusta-gtfs.mcapps.jp/static/53/latest.zip" },
	{ "key": "etajima-bus", "name": "江田島バス", "zipUrl": "https://gtfs-st.busit.jp/api/etajimabus" },
	{ "key": "chugoku-bus", "name": "中国バス", "zipUrl": "https://bus-vision.jp/gtfs_v2/chugokubus/gtfsFeed" },
	{ "key": "tomotetsu", "name": "鞆鉄道", "zipUrl": "https://bus-vision.jp/gtfs_v2/tomotetsubus/gtfsFeed" },
	{ "key": "ikasa-bus", "name": "井笠バスカンパニー", "zipUrl": "https://bus-vision.jp/gtfs_v2/ikasabus/gtfsFeed" }
]
```

- [ ] **Step 4: `busKyo.ts` を実装**

`pipeline/src/sources/busKyo.ts` を新規作成:

```ts
import manifestJson from './busKyoManifest.json';
import type { FeedSource, FeedTarget } from './types';

interface BusKyoEntry {
	/** R2キーに使う安定スラグ。URL・名称が変わっても不変にする */
	key: string;
	name: string;
	zipUrl: string;
}

const MANIFEST = manifestJson as BusKyoEntry[];
/** JIS 都道府県コード: 広島県 */
const PREF_HIROSHIMA = 34;

function toTarget(entry: BusKyoEntry): FeedTarget {
	return {
		id: `bus-kyo~${entry.key}`,
		name: entry.name,
		orgName: entry.name,
		license: 'CC0',
		fromDate: '',
		toDate: '',
		source: 'bus-kyo',
		// listing にバージョン情報が無いため空文字にし、feedProcessor に毎回再処理させる
		versionId: '',
		zipUrl: entry.zipUrl,
		prefId: PREF_HIROSHIMA,
	};
}

/** 広島県バス協会 GTFSオープンデータの固定17事業者を FeedTarget へ写像する。
 *  機械可読カタログが無いため、リポジトリ内マニフェストを唯一の情報源にする。 */
export function createBusKyoSource(): FeedSource {
	return {
		sourceId: 'bus-kyo',
		listTargets: async () => MANIFEST.map(toTarget),
	};
}
```

- [ ] **Step 5: テストと型チェックを実行して成功を確認**

Run:
```sh
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
pnpm --filter pipeline exec vitest run src/sources/busKyo.test.ts
pnpm --filter pipeline check
```
Expected: すべて PASS

- [ ] **Step 6: コミット**

```sh
git add pipeline/src/sources/busKyoManifest.json pipeline/src/sources/busKyo.ts pipeline/src/sources/busKyo.test.ts
git commit -m "feat(pipeline): 広島県バス協会(bus-kyo)の静的マニフェストソースを追加

17事業者(CC0)の固定リストをprefId=34のFeedTargetへ写像するcreateBusKyoSource()。
versionIdは空文字で常に再処理させる。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0124ys6pRc8MTWT3D7Ypg4ME"
```

---

## Task 3: パイプラインへ配線(scheduled ハンドラ)

月次 Cron の `sources` 配列に bus-kyo を加える。合成ルート(index.ts の default export)のため単体テストは無く、型チェックと Task 2 のソース単体テストで担保する。

**Files:**
- Modify: `pipeline/src/index.ts:22-24,37-44`

- [ ] **Step 1: import を追加**

`pipeline/src/index.ts` の `import { createCkanPackageSource } from './sources/ckanPackage';`(22行目付近)の直後に追加:

```ts
import { createBusKyoSource } from './sources/busKyo';
```

- [ ] **Step 2: `sources` 配列に追加**

`pipeline/src/index.ts` の `sources: [ ... ]` 配列内、`createCkanPackageSource({ ... })` ブロックの**後**(閉じ括弧 `}),` の次)に追加:

```ts
					createBusKyoSource(),
```

追加後の `sources` 配列は次の並びになる: `createGtfsDataJpSource()`, `createOdptSource(...)`, `createCkanPackageSource({...})`, `createBusKyoSource()`。

- [ ] **Step 3: 型チェックを実行して成功を確認**

Run:
```sh
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
pnpm --filter pipeline check
```
Expected: PASS

- [ ] **Step 4: コミット**

```sh
git add pipeline/src/index.ts
git commit -m "feat(pipeline): 月次CronのソースにbusKyoを追加

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0124ys6pRc8MTWT3D7Ypg4ME"
```

---

## Task 4: アプリの出典ラベル追加

`SOURCE_CREDITS` に bus-kyo を追加する。未登録でも id 生表示にフォールバックして壊れはしないが、出典表記のため追加する。

**Files:**
- Modify: `app/src/lib/Controls.svelte:26-30`

- [ ] **Step 1: `SOURCE_CREDITS` に追加**

`app/src/lib/Controls.svelte` の `SOURCE_CREDITS` を次に置き換える:

```ts
	const SOURCE_CREDITS: Record<string, string> = {
		'gtfs-data.jp': 'GTFSデータリポジトリ(gtfs-data.jp)',
		odpt: '公共交通オープンデータセンター(ODPT)',
		hoda: '北海道オープンデータプラットフォーム(HODA)',
		'bus-kyo': '広島県バス協会 GTFSオープンデータ',
	};
```

- [ ] **Step 2: 型チェックを実行して成功を確認**

Run:
```sh
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
pnpm --filter app check
```
Expected: PASS

- [ ] **Step 3: コミット**

```sh
git add app/src/lib/Controls.svelte
git commit -m "feat(app): データ出典に広島県バス協会(bus-kyo)を追加

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0124ys6pRc8MTWT3D7Ypg4ME"
```

---

## Task 5: 全体検証

コード変更完了後、全ワークスペースの検証コマンドを通す。

**Files:** なし(検証のみ)

- [ ] **Step 1: 全検証コマンドを実行**

Run:
```sh
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
pnpm --filter pipeline test
pnpm --filter pipeline check
pnpm --filter app check
pnpm format:check
```
Expected: すべて PASS。`format:check` で整形差分が出た場合は `pnpm format` を実行して差分をコミットする。

- [ ] **Step 2: 末尾4件の zip 実体を検証(手動・任意)**

`.zip` 拡張子でない API 風エンドポイントが GTFS 静的 zip を返すか、少なくとも1件を確認する:

```sh
curl -sL -o /tmp/etajima.zip 'https://gtfs-st.busit.jp/api/etajimabus'
file /tmp/etajima.zip           # → "Zip archive data" を期待
unzip -l /tmp/etajima.zip | grep -E 'stops.txt|trips.txt'   # GTFS 静的ファイルの存在確認
```
zip でない/GTFS でない場合は、そのフィードが本番で `status: "error"` になる(他フィードには影響しない)。継続的に失敗するなら、該当エントリを `busKyoManifest.json` から外すか要判断。

## 反映(マージ後・手動運用)

月次 Cron で自動取得されるが、即座に広島を表示するには一度きりの seed 実行(本番 R2 への投入)が必要。既存の `pipeline/.tmp/hoda-seed.mts` パターンを踏襲する。seed 後、`feeds.json` の `sources['bus-kyo']` 件数と `prefId=34` のフィード数、アプリのピッカーで広島県が選択可能になっていることを確認する。
