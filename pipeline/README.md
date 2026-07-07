# gtfs-view-bus-pipeline

## 全国 GTFS Queue pipeline

月次 Cron は GTFS 変換を直接実行せず、gtfs-data.jp 全国全件と ODPT 静的マニフェストから `FeedTarget` 一覧を作成して Cloudflare Queues へ投入する。Queue consumer は 1 メッセージ 1 フィードを処理し、全 status が R2 に揃った時だけ `feeds.json` を差し替える。

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

## First nationwide run

本番初回の全国投入は手動で実行し、`pipeline/jobs/current.json`、`pipeline/jobs/<jobId>/summary.json`、Queues の DLQ を確認する。Workers Free の CPU 制限では GTFS 変換の安定完走を前提にしないため、本番運用は Workers Paid を推奨する。
