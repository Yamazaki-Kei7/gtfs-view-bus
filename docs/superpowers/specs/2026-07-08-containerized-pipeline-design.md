# Cloudflare Containersパイプライン移行 設計書

日付: 2026-07-08
ステータス: 設計承認済み

## 背景と目的

全国GTFSパイプラインは、月次Cronが対象フィード一覧を作成し、Cloudflare Queuesで1フィード1メッセージとして処理している。現行のQueue consumerはWorker isolate内でGTFS zip取得、展開、変換、R2成果物書き込みを行うため、大規模フィードでWorkerのメモリ制限に到達する。

本設計の目的は、既存のCron、Queues、R2公開形式、アプリ側の `/data/*` 契約を維持したまま、メモリを使うフィード変換だけをCloudflare Containersへ移すことである。

## 確定要件

1. 既存のCloudflare Queuesは残し、1フィード1メッセージのジョブ分配を維持する。
2. Queue consumerはGTFS変換を直接行わず、Containerへ `FeedJobMessage` を委譲する。
3. ContainerはGTFS zip取得、展開、`gtfs-core` による変換、R2成果物書き込みまで担当する。
4. ContainerからR2へはCloudflare Containersのoutbound handlerを使い、R2のS3互換APIキーをContainerへ渡さない。
5. `feeds.json`、`feeds/<feedId>/bundle.json`、`routes.geojson`、`stops.geojson`、`timetable.json`、`meta.json` の公開キーとschemaは変更しない。
6. `feeds.json` は従来通り、全フィードのjob statusが揃った後だけ差し替える。
7. 初期運用は安定優先とし、Container `max_instances` とQueue `max_concurrency` を小さめに揃える。
8. TypeScriptの `class` は原則避けるが、Cloudflare Containersは `Container` 継承クラスが必要なため、その部分だけ例外とする。

## スコープ外

- アプリ側のデータ読み取り形式変更
- `feeds-next/<jobId>/...` のような完全原子的公開切替
- Workflowsを使ったパイプライン全体の再設計
- R2 FUSE mount
- ContainerからR2 S3互換APIへ直接アクセスする方式
- GTFS変換ロジック自体の大規模最適化

## 参照したCloudflare仕様

- ContainersはWorkers Paid planで利用し、WorkerからDurable Object binding経由でContainer instanceを制御する。
- `wrangler.jsonc` には `containers`、同じ `class_name` の `durable_objects.bindings`、`migrations.new_sqlite_classes` が必要である。
- Container instance typeは `lite`、`basic`、`standard-1` から `standard-4` などを指定できる。`standard-1` はWorker isolateより大きいメモリを持つため、初期候補にする。
- Containerはoutbound handlerを通じてWorker bindingsへアクセスできる。Container内から仮想ホストへHTTPリクエストし、Worker側のhandlerがR2 bindingを操作する。
- Queue consumerのDuration limitは15分である。Container処理を同期HTTPで待つ場合、1フィード処理はこの範囲内に収める必要がある。

参考:

- https://developers.cloudflare.com/containers/
- https://developers.cloudflare.com/containers/container-class/
- https://developers.cloudflare.com/containers/platform-details/limits/
- https://developers.cloudflare.com/containers/platform-details/workers-connections/
- https://developers.cloudflare.com/workers/wrangler/configuration/#containers
- https://developers.cloudflare.com/workers/platform/limits/

## アーキテクチャ

既存パイプラインの公開面は変えず、変換実行部だけをContainerへ移す。

```text
Cron Worker
  -> FeedTarget[]生成
  -> R2: pipeline/jobs/<jobId>/manifest.json
  -> Queue: FeedJobMessage

Queue consumer Worker
  -> 既存status確認
  -> Container Durable ObjectへPOST /process-feed
  -> FeedStatusをR2へ保存
  -> maybeFinalizeJob()

FeedProcessor Container
  -> GTFS zip/routes.geojson取得
  -> gtfs-core変換
  -> outbound handler経由でR2成果物を書き込み
  -> FeedStatusだけ返す
```

ContainerからWorkerへ返すレスポンスは小さな `FeedStatus` に限定する。`bundle.json` やGeoJSONのような大きい成果物をWorker経由で返さないことで、Workerメモリ制限に再び触れることを避ける。

## コンポーネント境界

### `pipeline/src/container.ts`

Cloudflare Containers用のDurable Object classを置く。`Container` を継承し、`defaultPort`、`sleepAfter`、必要なら `envVars`、`outboundByHost` を定義する。変換ロジックは持たせない。

`outboundByHost` はR2用の仮想ホストを処理する。Container内のNodeアプリが `http://r2/feeds/<feedId>/bundle.json` のようにHTTPリクエストすると、handlerが `env.DATA_BUCKET` に対してget/putを行う。

### `pipeline/container-app/`

Container内で動くNode.jsアプリを置く。HTTP APIは最小限にし、初期実装は `POST /process-feed` のみとする。

入力:

```ts
interface ProcessFeedRequest {
	jobId: string;
	target: FeedTarget;
}
```

出力:

```ts
type ProcessFeedResponse = FeedStatus;
```

このアプリは `gtfs-core` を使って変換し、R2 writer経由で成果物を書く。ODPTキー付きURLはContainer側で既存の `withOdptConsumerKey` 相当を使って取得する。`ODPT_CONSUMER_KEY` はWorker secretと同じ値をContainer runtime envとして渡すが、manifest、Queue message、R2には保存しない。

### `pipeline/src/containerDispatcher.ts`

Queue consumerからContainerを呼び出す責務を閉じ込める。`getContainer()`、Container instance名、HTTP path、timeout、レスポンス検証をここに集約する。

Container instance名は `jobId` と `target.id` から決める。1メッセージを1つのContainer instanceへ委譲し、メモリをフィード単位で分離する。低並列運用は固定shardではなく、Container `max_instances` とQueue consumer `max_concurrency` を揃えて制御する。

### `pipeline/src/consumer.ts`

既存の `processFeedTarget()` 呼び出しを `dispatchFeedToContainer()` に置き換える。job status保存、`maybeFinalizeJob()`、既存statusがある場合のfinalize再試行は維持する。

### `pipeline/src/feedProcessor.ts`

既存の変換処理はContainerアプリから再利用しやすい境界へ寄せる。ただし、Workerを経由した大きな成果物返却は避ける。必要であれば、成果物をまとめて返す関数ではなく、成果物writerを受け取って順次書く関数へ変更する。

## データフロー

1. Cronがgtfs-data.jpとODPTから `FeedTarget[]` を収集する。
2. CronがR2に `pipeline/jobs/<jobId>/manifest.json` と `pipeline/jobs/current.json` を保存する。
3. CronがQueueに `FeedJobMessage` を投入する。
4. Queue consumerが対象フィードの既存job statusを確認する。既に存在する場合は変換を再実行せず `maybeFinalizeJob()` だけ呼ぶ。
5. Queue consumerがContainerへ `POST /process-feed` を送る。
6. Containerがoutbound R2 handler経由で `feeds/<feedId>/meta.json` を読む。
7. `versionId`、`OUTPUT_SCHEMA_VERSION`、`prefId` 条件が満たされれば `unchanged` を返す。
8. 更新が必要な場合、Containerがzipと必要なroutes GeoJSONを取得し、GTFSを変換する。
9. Containerがoutbound R2 handler経由で `bundle.json`、`routes.geojson`、`stops.geojson`、`timetable.json` を書く。
10. Containerが最後に `meta.json` を書く。
11. Containerが `updated` または `error` の `FeedStatus` を返す。
12. Queue consumerが `pipeline/jobs/<jobId>/statuses/<encodedFeedId>.json` を保存する。
13. `maybeFinalizeJob()` が全status完了を検出した場合だけ `feeds.json` とsummaryを差し替える。

## エラー処理

フィード単位の失敗はContainer内で `status: "error"` に変換する。対象はzip取得失敗、routes GeoJSON取得失敗、GTFS zip展開失敗、CSV解析失敗、変換失敗などである。この場合、Queue messageはackし、全体の `feeds.json` 差し替えは他フィード完了後に進める。

インフラ系の失敗はQueue retry対象にする。対象はContainer起動失敗、Container HTTP timeout、Containerレスポンス不正、outbound R2 handlerの予期しない失敗、job status保存失敗である。この場合、consumerはthrowし、Queuesの `max_retries` とDLQに任せる。

Queue consumerには15分のDuration limitがあるため、Container同期処理は1フィード15分以内に収める。初期実装ではdispatcher timeoutを15分未満に設定し、超過時はインフラ系失敗としてretryする。もし本番観測で15分を超えるフィードがある場合は、次の設計としてWorkflows、HTTP pull consumer、またはContainerがjob statusを自律書き込みする非同期方式を検討する。

DLQに落ちたメッセージはstatus未完了のまま残る。その場合、`feeds.json` は差し替えられず前回公開版を維持する。これは既存の「全statusが揃った時だけ公開する」方針と一致する。

## Cloudflare設定

`pipeline/wrangler.jsonc` に次を追加する。

```jsonc
{
	"containers": [
		{
			"class_name": "FeedProcessorContainer",
			"image": "./Dockerfile",
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
	]
}
```

初期値は `standard-1`、`max_instances: 5`、Queue consumer `max_concurrency: 5` を候補にする。大規模フィードがなおメモリ不足になる場合は `standard-2` 以上へ上げる。外部配布元やR2への負荷を見ずに並列度だけを上げない。

Container local developmentはDockerが必要である。`dev.enable_containers` は既定で有効だが、DockerなしでWorker側テストだけ動かしたい場合は開発手順に無効化方法を記載する。

## テスト計画

### Containerアプリ単体

- `POST /process-feed` が `unchanged` を返す。
- `POST /process-feed` が更新時に5つの成果物をR2 writerへ書く。
- `meta.json` が最後に書かれる。
- zip取得失敗や変換失敗が `status: "error"` になる。
- R2 writer失敗は通常のフィードエラーではなくthrowされる。

### Worker dispatcher/consumer

- consumerが既存statusを見つけた場合、Containerを呼ばずfinalizeだけ試みる。
- consumerがContainerから返った `FeedStatus` をjob statusとして保存する。
- Container timeout、HTTP 500、JSON不正、status schema不正はthrowされる。
- `maybeFinalizeJob()` の既存テストは維持する。

### Cloudflare設定

- `pnpm --filter pipeline test`
- `pnpm --filter pipeline check`
- `pnpm --filter pipeline cf:types`
- `pnpm --filter pipeline cf:check`

Dockerが利用できる環境では、Containerを含むローカル起動またはremote devで小さなフィードを1件処理し、R2成果物とsummaryを確認する。

## 移行方針

1. `@cloudflare/containers` を追加し、Container Durable Object classとWrangler設定を追加する。
2. Containerアプリの最小HTTP APIとDockerfileを追加する。
3. 既存 `feedProcessor` をContainerから再利用できる形へ変更する。
4. consumerをContainer dispatcher経由へ切り替える。
5. 単体テストとCloudflare設定検証を通す。
6. 本番初回は手動scheduled実行で、`pipeline/jobs/current.json`、summary、DLQ、Cloudflare logsを確認する。
7. 完走時間、Containerメモリ、失敗フィード、R2書き込み量を観測し、`instance_type` と `max_instances` を調整する。

## 既知のリスク

- 1フィードの処理がQueue consumerの15分制限を超える場合、同期委譲では完走できない。その場合はWorkflowsや非同期Container方式が必要になる。
- ContainerがR2へ直接成果物を書くため、`feeds.json` 差し替え前に個別ファイルが更新される可能性は従来通り残る。
- outbound handlerのR2仮想API設計を広げすぎると、Containerから任意キーを書ける面が広がる。初期実装では `feeds/` 配下の必要なキーだけに絞る。
- ODPTのキー付き配布URLをContainerで取得するため、`ODPT_CONSUMER_KEY` をContainer runtime envへ渡す必要がある。キーはmanifest、Queue message、R2には保存しない。
- Dockerを使うローカル開発が必須になる範囲が増える。CIでは少なくとも型チェック、単体テスト、Wrangler dry-runを必須にする。
