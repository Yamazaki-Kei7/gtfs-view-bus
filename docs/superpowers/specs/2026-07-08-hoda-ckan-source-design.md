# HODA CKANデータソース追加 設計書

日付: 2026-07-08
ステータス: 設計承認済み

## 背景と目的

現在のパイプラインは、gtfs-data.jp と公共交通オープンデータセンター(ODPT)をデータソースとしている。北海道オープンデータプラットフォーム(HODA)には、これらだけではカバーできない公共交通 GTFS が公開されている。

本設計の目的は、HODA の `gtfs-data` データセットを取り込み対象に追加し、北海道の直接 ZIP 配布 GTFS を R2 へ変換・公開できるようにすることである。あわせて、今後ほかの自治体・地域 CKAN が追加されても実装が散らばらないよう、CKAN package を `FeedSource` に変換する汎用モジュールを導入する。

## 確定要件

1. HODA の `https://ckan.hoda.jp/dataset/gtfs-data` を取り込み対象にする。
2. HODA の一覧取得は CKAN API `GET https://ckan.hoda.jp/api/3/action/package_show?id=gtfs-data` を使う。
3. HODA 上の直接 ZIP ダウンロードとして公開されている公共交通 GTFS を対象にする。
4. バスだけに限定しない。フェリーと市電の GTFS も対象に含める。
5. 観光データなど、公共交通の運行 GTFS ではないリソースは除外する。
6. URL 空、外部ページリンク、HTMLリンクだけのリソースは初回対象外にする。
7. HODA は `prefId: 1` として北海道に紐づける。
8. 既存の R2 公開形式、`feeds.json` 形式、アプリ側の `/data/*` 読み取り契約は維持する。
9. ソース一覧取得失敗とフィード単位失敗は、既存の全国パイプラインのエラー処理に乗せる。

## スコープ外

- 外部ページリンク先から GTFS ZIP を探索するクローラ
- HODA 以外の CKAN サイトの同時追加
- アプリ全体の名称・説明を公共交通全般へ全面変更すること
- GTFS-RT 対応
- HODA の Web ページ HTML スクレイピング

## アーキテクチャ

既存の `FeedSource` 境界を維持し、`pipeline/src/sources/ckanPackage.ts` を追加する。

このモジュールは CKAN `package_show` レスポンスを入力に、対象リソースの判定、安定 ID 生成、差分検出キー生成、`FeedTarget` 変換を内部に閉じ込める。呼び出し側は `createCkanPackageSource(config)` だけを使う。

```ts
export interface CkanPackageSourceConfig {
	sourceId: SourceId;
	baseUrl: string;
	packageId: string;
	prefId: number | null;
	excludedNamePatterns?: RegExp[];
}
```

HODA の設定は次を想定する。

```ts
createCkanPackageSource({
	sourceId: 'hoda',
	baseUrl: 'https://ckan.hoda.jp',
	packageId: 'gtfs-data',
	prefId: 1,
	excludedNamePatterns: [/観光データ/],
});
```

`SourceId` は `'gtfs-data.jp' | 'odpt' | 'hoda'` に拡張する。`Record<SourceId, number>` を使う既存箇所は、`hoda` の件数集計漏れを型チェックで検出できる状態を保つ。

## HODA抽出ルール

HODA は CKAN API の `result.resources` を順に評価する。

対象にする条件:

1. `state === 'active'`
2. `url` が HODA ドメイン上の直接 ZIP ダウンロード
3. `format` または `mimetype` が ZIP と見なせる
4. 除外名パターンに一致しない

除外する条件:

- URL 空
- 外部ページリンク
- HTMLリンクだけのリソース
- `観光データ` など公共交通の運行 GTFS ではないもの

フェリーと市電は対象に含める。ODPT の `odptEntryMode` のようなバス限定フィルタは HODA には適用しない。

## FeedTarget変換

フィード ID は `hoda~<resourceId>` とする。ファイル名や URL は更新で変わる可能性があるため ID に含めない。

`FeedTarget` は次のように生成する。

- `id`: `hoda~<resource.id>`
- `name`: `resource.name`
- `orgName`: package の `organization.title` を優先し、無ければ dataset title
- `license`: package の `license_title` を優先
- `fromDate`: 空文字
- `toDate`: 空文字
- `source`: `'hoda'`
- `versionId`: CKAN metadata 由来の安定文字列
- `zipUrl`: `resource.url`
- `prefId`: `1`

HODA API には運行期間が無いため `fromDate` / `toDate` は空文字にする。実際の運行日判定は GTFS 内の `calendar.txt` / `calendar_dates.txt` に基づくため、地図上の運行判定には影響しない。

`versionId` は ZIP 本体を差分検出のためだけに取得せず、CKAN metadata から生成する。具体的には `resource.id`、`last_modified`、`revision_id`、`size` を組み合わせる。`last_modified` が無い場合でも `revision_id` と `size` が変化すれば再処理される。

## エラー処理

CKAN package 取得に失敗した場合、または `success: true` でない場合、`createCkanPackageSource().listTargets()` は例外を投げる。これは gtfs-data.jp の一覧取得失敗と同じく、`createFeedJob` の失敗経路に乗せる。Queue 投入、`feeds.json` 差し替え、孤児掃除は行わない。

個別 ZIP の取得、GTFS 展開、CSV 解析、変換に失敗した場合は、既存どおりフィード単位で `status: "error"` を記録する。1フィードの破損でジョブ全体は止めない。

## アプリ側の変更

`app/src/lib/Controls.svelte` の `SOURCE_CREDITS` に HODA を追加する。

```ts
const SOURCE_CREDITS: Record<string, string> = {
	'gtfs-data.jp': 'GTFSデータリポジトリ(gtfs-data.jp)',
	odpt: '公共交通オープンデータセンター(ODPT)',
	hoda: '北海道オープンデータプラットフォーム(HODA)',
};
```

HODA フィードは `prefId: 1` を持つため、既存の都道府県集計では北海道に入る。

フェリーと市電を含めるため、バス前提の小さな表示文言は必要最小限だけ直す。具体的には `運行中: n台` を `運行中: n件` に変更する。アプリ名や説明文の全面変更は別設計で扱う。

## テスト計画

`pipeline/src/sources/ckanPackage.test.ts` を追加し、次を確認する。

- CKAN `package_show` レスポンスから `FeedTarget` を生成する。
- HODA の直接 ZIP リソースから `hoda~<resourceId>` の安定 ID を生成する。
- フェリーと市電は除外されない。
- 観光データ、URL 空、外部ページリンク、HTMLリンクは除外される。
- `versionId` が `resource.id`、`last_modified`、`revision_id`、`size` から安定して生成される。
- CKAN API の `success: false`、HTTP error、resources 欠落を一覧取得失敗として扱う。

既存テストへの追加確認:

- `jobProducer` の `sources` 集計に `hoda` が入る。
- `finalize` と `JobSummary` が `hoda` を含む `Record<SourceId, number>` を扱える。
- `Controls.svelte` / app の型チェックで `hoda` クレジット追加が壊れていない。

検証コマンド:

```sh
pnpm --filter pipeline test
pnpm --filter pipeline check
pnpm --filter app check
```

必要に応じて、実装後に Worker の scheduled 実行で `feeds.json` の `sources.hoda` と北海道の `prefId: 1` 件数を確認する。

## 運用上の注意

HODA の dataset notes には、利用前に用途確認フォームへの記入依頼がある。コード上の制約ではないが、公開運用前にプロジェクトとして利用手続きを済ませたか確認する。

## 採用しない案

### HODA専用ソース

最短実装だが、次の自治体 CKAN 追加時に似たファイルが増える。今回の「今後も追加される」前提に合わないため採用しない。

### 外部ページリンク先の探索

カバー率は上がるが、自治体サイトごとの HTML 構造・ファイル配置に依存する。初回は HODA 上の直接 ZIP に限定し、安定運用を優先する。

### 外部レジストリ manifest への統合

ODPT は HTML 解析、HODA は CKAN API で取得方法が異なる。今まとめると抽象が大きくなりすぎるため、今回は `FeedSource` 境界で統一し、内部実装は分ける。
