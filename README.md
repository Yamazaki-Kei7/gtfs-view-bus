# gtfs-view-bus

全国のGTFSフィード(gtfs-data.jp・公共交通オープンデータセンター)をもとに、指定日時のバス推定位置を地図上に表示するWebGIS。

- 設計書: `docs/superpowers/specs/2026-07-05-gtfs-bus-position-webgis-design.md`
- 実装計画: `docs/superpowers/plans/2026-07-05-gtfs-bus-position-webgis.md`
- 全国パイプライン設計: `docs/superpowers/specs/2026-07-07-nationwide-pipeline-design.md`
- 全国パイプライン計画: `docs/superpowers/plans/2026-07-07-nationwide-pipeline.md`
- 構成: `pipeline/`(月次Cron + Queues + Containers + R2) → `app/`(SvelteKit on Workers) → MapLibre
- 共有ロジック: `packages/gtfs-core/`(CSVパース・shape射影・キーフレーム補間・カレンダー判定)
- IaC: `infra/`(Terraform, R2バケット) + 各 `wrangler.jsonc`

## 開発

前提: Node 22 以上 + pnpm 10 + [just](https://just.systems)(`brew install just`)。

日常のタスクは root から `just` で実行する。`just` を引数なしで実行するとレシピ一覧が表示される。

```bash
just setup   # 依存関係のインストール
just test    # 全パッケージのテスト
just check   # 全パッケージの型チェック
just lint    # ESLint
just format  # Prettier で整形
just build   # アプリのプロダクションビルド
just ci      # CI と同じチェックを一括実行(format:check → lint → check → test → build)
```

### ローカルで動かす

```bash
# ターミナル1: パイプラインWorkerを起動(ローカルR2に永続化)
just pipeline

# ターミナル2: ローカルR2にGTFSデータを投入(初回のみ)
just seed

# ターミナル2: フロント開発サーバーを起動
just dev
```

just を使わない場合の生コマンドは `justfile` を参照。

### Pipeline

`pipeline/` は Cloudflare Workers Cron + Queues + Containers + R2 で GTFS を月次変換する。Cron は対象フィード一覧を作って Queue へ投入し、Queue consumer は Container へ 1 フィード単位で変換を委譲する。Container は R2 outbound handler 経由で成果物を書き込み、全 status が揃った時だけ `feeds.json` を差し替える。公開形式は `feeds.json` と `feeds/<feedId>/...` を維持するため、アプリ側の `/data/*` 読み取り契約は変えない。

詳しい検証手順と ODPT マニフェスト更新手順は `pipeline/README.md` を参照。

### Cronを手動実行する

パイプラインWorkerは月次Cronでフィード処理ジョブを Queues へ投入し、Queue consumer が Container へ変換を委譲する。Container は R2 へ `feeds/*` を書き込み、全 status が揃った時だけ Worker が `feeds.json` を差し替える。
WorkerをデプロイしてもCronは即時実行されないため、データソース追加後や初回投入時は手動実行が必要。

#### ローカルR2を更新する

ローカル開発用のR2(`../.wrangler/state`)へデータを投入する手順。

```bash
# ターミナル1: scheduledテストエンドポイント付きでパイプラインWorkerを起動
just pipeline

# ターミナル2: ローカルR2へデータを生成
just seed
```

`just`を使わない場合:

```bash
# ターミナル1
cd pipeline
pnpm dev

# ターミナル2
curl -fsS "http://localhost:8787/__scheduled?cron=0+20+L+*+*"
```

#### 本番初回実行を確認する

本番WorkerのCronを待たずに初回投入する場合は、デプロイ済みWorkerの scheduled handler を手動実行し、Queues と R2 のジョブ状態を確認する。全国全件の変換はCPU時間とQueue処理量が大きいため、本番運用は Workers Paid を前提にする。

実行後、本番R2の `feeds.json` と job summary を取得して `generatedAt`、フィード件数、失敗件数を確認する:

```bash
cd pipeline
set -a
source ../.env
set +a
WRANGLER_LOG_PATH=.tmp/wrangler-logs pnpm exec wrangler r2 object get \
  gtfs-view-bus-data/feeds.json \
  --remote \
  --file .tmp/remote-feeds.json

node -e 'const fs = require("fs"); const j = JSON.parse(fs.readFileSync(".tmp/remote-feeds.json", "utf8")); const counts = j.feeds.reduce((m, f) => { const k = f.source || "missing"; m[k] = (m[k] || 0) + 1; return m; }, {}); console.log(j.generatedAt); console.log(j.feeds.length); console.log(counts);'
```

`pipeline/jobs/current.json` の `jobId` をもとに `pipeline/jobs/<jobId>/summary.json` も確認する。DLQ にメッセージが残っている場合は、該当フィードの status と Worker ログを見てから再実行する。

アプリ側の `/data/*` は `cache-control: public, max-age=300` のため、R2更新後の画面反映には最大5分程度かかる。

## デプロイ

1. `infra/` で R2 バケットを作成(infra/README.md 参照)
2. GitHub Environment `production` に `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` を設定
3. main へマージすると GitHub Actions がデプロイ
4. 初回はデータが空なので、上記「本番初回実行を確認する」の手順でデータを投入する

## ライセンス・出典

- バスデータ: GTFSデータリポジトリ(gtfs-data.jp)および公共交通オープンデータセンター(ODPT)の各事業者フィード(CC BY 4.0 等、feeds.json に記載)
- 地図タイル: © OpenStreetMap contributors
