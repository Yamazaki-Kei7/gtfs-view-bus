# 全国GTFSパイプライン対応 設計書

日付: 2026-07-07
ステータス: 設計承認済み

## 背景と目的

現行パイプラインは、gtfs-data.jp を `GTFS_PREF_ID=10` で群馬県に限定し、ODPT は群馬周辺の8フィードをコード内定数で扱っている。今後は全国のGTFSデータを処理対象にしたい。

本設計の目的は、`gtfs-view-bus-pipeline` が全国データを取得・変換・R2保存できるようにすることである。アプリ側の全国向け閲覧UI、地域選択、初回ロード最適化は本設計の対象外とする。

## 確定要件

1. 対象ソースは gtfs-data.jp 全件と ODPT の GTFS/GTFS-JP フィードとする。
2. gtfs-data.jp は `GET https://api.gtfs-data.jp/v2/files` で全国全件を取得する。
3. ODPT は開発時スクリプトでCKAN HTMLを解析し、静的マニフェストを更新する。Worker実行時にはHTML解析を行わない。
4. 全国規模の変換は Cloudflare Queues を使い、Cron はフィード単位メッセージ投入を担当する。
5. `feeds.json` は全フィードの処理結果が揃った後に一括差し替えする。処理途中の歯抜け状態は公開しない。
6. 本番の全国変換運用は Workers Paid を推奨する。Queues自体は無料枠内に収まる見込みだが、Workers Free のCPU制限ではGTFS変換の安定完走を前提にしない。
7. 既存の公開データ形式、R2キー、アプリ側の `/data/*` 読み取り形式は維持する。

## スコープ外

- アプリ側の全国全量ロード対策
- 地域・都道府県・事業者選択UI
- ベクトルタイル、PMTiles、FlatGeobufなどへの配信形式変更
- GTFS-RT対応
- ODPTカタログの実行時動的発見
- 完全な原子的公開切替のための `feeds-next/<jobId>/...` 二重書き込み

## 現状の制約

`pipeline/src/run.ts` は `FeedSource[]` を逐次処理し、フィード単位のエラー処理、`meta.json` による差分スキップ、R2孤児削除、`feeds.json` の一括更新を持っている。この構造は小規模では十分だが、全国の数百フィードを1回のCron invocationで処理するには不向きである。

一方、変換済み成果物の形式は既にフィード単位で分割されている。

```text
feeds.json
feeds/<feedId>/bundle.json
feeds/<feedId>/routes.geojson
feeds/<feedId>/stops.geojson
feeds/<feedId>/timetable.json
feeds/<feedId>/meta.json
```

そのため、変換実行だけをQueue化し、公開形式は維持する方針を採る。

## アーキテクチャ

パイプラインを次の3層に分ける。

### 1. カタログ生成層

gtfs-data.jp と ODPT から、JSON化できる `FeedTarget` 一覧を生成する。

```ts
export interface FeedTarget {
	id: string;
	name: string;
	orgName: string;
	license: string | null;
	fromDate: string;
	toDate: string;
	source: SourceId;
	versionId: string;
	zipUrl: string;
	routesGeojsonUrl?: string;
}
```

`FeedTarget` はQueueメッセージ、R2上のmanifest、テストフィクスチャで共通に使う。関数を持たせないため、現在の `FeedDescriptor.fetchZip()` よりも分散処理に向く。

gtfs-data.jp は `createGtfsDataJpSource({ prefIds?: number[] })` のようなAPIにし、`prefIds` が未指定なら `/v2/files` で全国全件を取得する。検証やローカル実行では県IDリストで絞り込める余地を残す。

ODPT は `pipeline/src/sources/odptManifest.json` を実行時の入力にする。既存の群馬8フィードもこのマニフェストに含め、コード内定数から移行する。

### 2. ジョブ投入層

月次Cronはフィード変換を直接行わない。Cronは次の処理だけを行う。

1. `jobId` を生成する。
2. gtfs-data.jp 全件とODPTマニフェストから `FeedTarget[]` を作る。
3. R2へ `pipeline/jobs/<jobId>/manifest.json` と `pipeline/jobs/current.json` を保存する。
4. Queueへフィード単位メッセージを `sendBatch` で投入する。

Queueメッセージは `jobId` と `FeedTarget` を持つ。

```ts
export interface FeedJobMessage {
	jobId: string;
	target: FeedTarget;
}
```

### 3. フィード処理層

Queue consumer は1メッセージ=1フィードを処理する。処理は既存 `processFeed` 相当の責務を関数として切り出し、`FeedTarget` を入力にする。

処理順は現行の冪等性保証を維持する。

1. `feeds/<feedId>/meta.json` を読み、`versionId` と `schemaVersion` が一致すれば `unchanged` とする。
2. 更新が必要なら `zipUrl` からGTFS zipを取得する。
3. `routesGeojsonUrl` があれば取得し、なければ `gtfs-core` で生成する。
4. `bundle.json`、`routes.geojson`、`stops.geojson`、`timetable.json` を書く。
5. 最後に `meta.json` を書く。
6. `pipeline/jobs/<jobId>/statuses/<encodedFeedId>.json` に結果を書く。

## R2ジョブ状態

R2に次のキーを追加する。

```text
pipeline/jobs/<jobId>/manifest.json
pipeline/jobs/<jobId>/statuses/<encodedFeedId>.json
pipeline/jobs/<jobId>/summary.json
pipeline/jobs/current.json
```

`manifest.json` は今回の対象フィード一覧、作成時刻、ソース一覧取得結果、前回公開indexの参照情報を持つ。

`statuses/<encodedFeedId>.json` はフィード単位結果を持つ。`encodedFeedId` はR2キーとして安全な形式にする。IDに `/` は使わない想定だが、将来の安全性のため明示的にエンコードする。

`summary.json` は完了後の集計を持つ。

```json
{
	"jobId": "20260707T120000Z-a1b2c3",
	"generatedAt": "2026-07-07T12:00:00.000Z",
	"total": 646,
	"updated": 120,
	"unchanged": 500,
	"error": 26,
	"sources": { "gtfs-data.jp": 540, "odpt": 106 },
	"published": true
}
```

`current.json` は最新ジョブの `jobId` と状態を持ち、運用時の確認を容易にする。

## 公開切替

`feeds.json` は全フィードのstatusが揃った後にだけ生成して差し替える。処理中は前回公開版を維持する。

各consumerは自分のstatusを書いた後、`manifest.json` の全IDについてstatusの存在を確認する。全statusが揃っていればfinalize処理を実行する。

R2に強いロックを期待しないため、finalizeは冪等処理として設計する。同じ `manifest.json` と同じstatus集合からは同じ `feeds.json` と `summary.json` が生成される。複数consumerが同時にfinalizeしても結果が同一なら問題にしない。

フィード単位の成果物は従来どおり `feeds/<feedId>/...` に直接書く。これにより、既存フィードの同一ID更新では `feeds.json` 差し替え前に個別ファイルが更新される可能性がある。完全な原子的公開ではないが、R2容量と実装量を抑えるため本設計では受け入れる。新規フィードや削除フィードは `feeds.json` が差し替わるまで通常導線から参照されない。

## エラー処理

### ソース一覧失敗

gtfs-data.jp 全件取得、またはODPTマニフェスト読み込みに失敗した場合、そのジョブは `failed` として扱う。Queue投入、`feeds.json` 差し替え、孤児掃除は行わない。前回公開版を維持する。

### フィード単位失敗

zip取得、GTFS展開、CSV解析、変換、GeoJSON取得に失敗したフィードは `status: "error"` として記録する。全フィードのstatusが揃えば、errorを含んだ `feeds.json` を公開する。1フィードの破損で全国更新全体を止めない。

### QueueリトライとDLQ

通常のフィード処理エラーはconsumer内で捕捉し、`error` statusを書いてackする。Queueでリトライさせるのは、R2書き込み不可などstatus記録自体に失敗したインフラ系エラーに限定する。

DLQは設定するが、DLQに落ちたメッセージはstatus未完了の原因になる。運用では `current.json` と `summary.json`、Cloudflare QueuesのDLQを確認して再実行する。

## ODPTマニフェスト更新

`pipeline/scripts/update-odpt-manifest.ts` を追加する。これは開発時に実行するスクリプトであり、Worker実行時には使わない。

スクリプトはCKANの `GTFS/GTFS-JP` 一覧HTMLをページング取得し、各データセットページとリソースページから次を抽出する。

- dataset id
- resource id
- operator
- feed
- name
- orgName
- license
- zipUrl
- resource title
- 取得できる場合は `fromDate` / `toDate`

HTML依存のため、抽出に失敗した場合は既存マニフェストを壊さない。更新結果は差分レビューしやすいよう、安定ソートと整形済みJSONで書く。

## Cloudflare設定

`gtfs-view-bus-pipeline` Workerに `scheduled()` と `queue()` の両ハンドラを持たせる。

`pipeline/wrangler.jsonc` にはQueue producer/consumer bindingを追加する。初期設定は保守的にする。

- `max_batch_size`: 小さめ
- `max_concurrency`: 小さめ
- `max_retries`: status記録不能時の再試行用
- `dead_letter_queue`: あり
- `limits.cpu_ms`: Workers Paidで必要に応じて拡張

全国変換の本番運用はWorkers Paidを推奨する。Queuesの操作回数は月次全国更新で無料枠内に収まる見込みだが、GTFS変換はWorkers FreeのCPU制限を超える可能性が高い。

## 孤児掃除

孤児掃除は `feeds.json` の公開差し替え後に行う。active IDは今回のmanifestに含まれる全フィードIDとする。`status: "error"` のフィードもactive扱いにし、既存成果物を削除しない。

ソース一覧失敗時、manifest未作成時、status未完了時は孤児掃除を行わない。

## テスト計画

- gtfs-data.jp 全件モード: `pref` なしで `/v2/files` を呼び、`FeedTarget` を生成する。
- gtfs-data.jp 絞り込みモード: 県IDリスト指定で従来互換のURLを呼ぶ。
- ODPTマニフェスト: JSONから `FeedTarget` を生成し、既存群馬ODPT相当のID互換を保つ。
- ODPTマニフェスト更新スクリプト: 保存済みHTMLフィクスチャからマニフェストを生成する。
- ジョブ投入: `manifest.json`、`current.json`、Queue `sendBatch` 分割を検証する。
- フィード処理: `updated`、`unchanged`、`error` status保存を検証する。
- finalize: 全status完了時だけ `feeds.json` と `summary.json` を生成する。
- finalize冪等性: 同じ入力で複数回実行しても同じ出力になる。
- ソース一覧失敗: `feeds.json` 差し替えと孤児掃除を行わない。
- Queue処理エラー: 通常のフィードエラーはthrowせず `error` statusになる。
- 既存変換保証: `meta.json` を最後に書く、`shapeSourceCounts` を引き継ぐ、`timetable.json` を生成する。

## 移行方針

1. `FeedDescriptor` 中心の同期実行を、JSON化可能な `FeedTarget` 中心の処理へ段階移行する。
2. 既存 `runPipeline()` のテスト資産を、ジョブ作成・フィード処理・finalizeの単位に分割する。
3. ODPTのコード内定数を静的マニフェストへ移す。
4. Queue bindingを追加し、ローカルでは小さなフィード集合で動作確認する。
5. 本番初回全国投入は手動実行で監視し、問題がなければ月次Cron運用に移行する。

## 既知のリスク

- ODPTのHTML構造が変わるとマニフェスト更新スクリプトが失敗する。実行時Workerには影響しないが、マニフェスト更新時に修正が必要になる。
- 全国全量の成果物を現在のアプリが初回ロードすると重くなる可能性が高い。本設計ではパイプライン対応に限定し、アプリ最適化を別途扱う。
- R2への直接上書きにより、同一IDの既存フィードは完全な原子的公開ではない。必要になった場合は `feeds-next/<jobId>/...` への二重書き込みと昇格方式へ移行する。
- フィード数増加によりR2容量が増える。初回全国投入後に実サイズを測定し、保持ポリシーを再評価する。
