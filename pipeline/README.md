# gtfs-view-bus-pipeline

## 全国 GTFS Queue pipeline

月次 Cron は GTFS 変換を直接実行せず、gtfs-data.jp 全国全件と ODPT 静的マニフェストから `FeedTarget` 一覧を作成して Cloudflare Queues へ投入する。Queue consumer は 1 メッセージ 1 フィードを Cloudflare Containers へ委譲し、全 status が R2 に揃った時だけ `feeds.json` を差し替える。

## Container processing

Queue consumer は GTFS 変換を直接実行せず、Cloudflare Containers の `FeedProcessorContainer` へ 1 フィード単位で処理を委譲する。Container は `gtfs-core` で変換し、outbound handler 経由で R2 へ `feeds/<feedId>/...` を直接書く。Worker へ戻す値は小さな `FeedStatus` のみ。

ローカルで Containers を含めて動かすには Docker が必要。Docker なしで Worker 側の単体テストだけ実行する場合は、`pnpm --filter pipeline test` と `pnpm --filter pipeline check` を使う。

検証コマンド:

```bash
pnpm --filter pipeline test
pnpm --filter pipeline check
pnpm --filter pipeline cf:types
pnpm --filter pipeline cf:check
```

本番初回投入後は `pipeline/jobs/current.json`、`pipeline/jobs/<jobId>/summary.json`、Queues DLQ、Cloudflare logs を確認する。DLQ に落ちたメッセージがある場合、`feeds.json` は差し替わらず前回公開版を維持する。

## R2 keys

- `feeds.json`
- `feeds/<feedId>/bundle.json`
- `feeds/<feedId>/routes.geojson`
- `feeds/<feedId>/stops.geojson`
- `feeds/<feedId>/timetable.json`
- `feeds/<feedId>/meta.json`
- `pipeline/jobs/<jobId>/manifest.json`
- `pipeline/jobs/<jobId>/statuses/<encodedFeedId>.json`
- `pipeline/jobs/<jobId>/summary.json`
- `pipeline/jobs/current.json`

## Verification

```bash
pnpm --filter pipeline test
pnpm --filter pipeline check
pnpm --filter pipeline cf:check
pnpm --filter pipeline cf:types
```

## ODPT manifest update

```bash
pnpm --filter pipeline update:odpt-manifest
git diff -- pipeline/src/sources/odptManifest.json
```

更新スクリプトは開発時だけ実行する。Worker 実行時に CKAN HTML は解析しない。

- マニフェストにはバスのGTFSのみ載せる(鉄道・フェリーはデータセット名等のキーワードで生成時に除外)。
- 配布URLは `api-public.odpt.org`(キー不要)と `api.odpt.org`(`requiresKey: true`、開発者キー必要)の両方を含む。Challenge限定配布(`api-challenge.odpt.org`)は対象外。
- フィード件数が前回より減る場合は抽出漏れの可能性としてエラーにする。意図した削減は `--force` を付けて実行する。

## ODPT 開発者キー(ODPT_CONSUMER_KEY)

[developer.odpt.org](https://developer.odpt.org/) で発行したアクセストークンを設定すると、`requiresKey` フィード(西武バス・京王バス・関東バス・京都市営バス・横浜市営バスなど約28件)も処理対象に含まれる。**未設定なら public 配布のみで従来どおり動作する。**

- ローカル: `pipeline/.dev.vars` に `ODPT_CONSUMER_KEY=<トークン>` を書く(gitignore 済み)
- 本番: `cd pipeline && pnpm exec wrangler secret put ODPT_CONSUMER_KEY`

キーは取得リクエストの瞬間だけ `api.odpt.org` 宛URLへ付与され(`withOdptConsumerKey`)、manifest・Queueメッセージ・R2 のいずれにも保存されない。

## First nationwide run

本番初回の全国投入は手動で実行し、`pipeline/jobs/current.json`、`pipeline/jobs/<jobId>/summary.json`、Queues の DLQ を確認する。Workers Free の CPU 制限では GTFS 変換の安定完走を前提にしないため、本番運用は Workers Paid を推奨する。
