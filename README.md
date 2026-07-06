# gtfs-view-bus

群馬県のGTFSフィード(gtfs-data.jp・公共交通オープンデータセンター)をもとに、指定日時のバス推定位置を地図上に表示するWebGIS。

- 設計書: `docs/superpowers/specs/2026-07-05-gtfs-bus-position-webgis-design.md`
- 実装計画: `docs/superpowers/plans/2026-07-05-gtfs-bus-position-webgis.md`
- 構成: `pipeline/`(月次変換Worker) → R2 → `app/`(SvelteKit on Workers) → MapLibre
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

### Cronを手動実行する

パイプラインWorkerは月次CronでR2へ `feeds.json` と `feeds/*` を生成する。
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

#### 本番R2を一度だけ更新する

本番WorkerのCronを待たずに、本番R2へデータを再生成する手順。
`wrangler dev --remote` はCloudflare上の一時プレビュー環境でWorkerを実行するため、GTFS変換処理ではCPU制限に達することがある。
そのため、一時的なWrangler設定でR2バインディングだけ `remote: true` にし、Worker本体はローカルで実行する。
本番R2を書き換えるため、実行前に対象ブランチがデプロイ済みコードと一致していることを確認する。

前提: リポジトリルートの `.env` に `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` が入っていること。

```bash
# ターミナル1: Workerはローカル実行、R2だけ本番接続にする一時configを作成して起動
cd pipeline
mkdir -p .tmp
cat > .tmp/wrangler-remote-r2.jsonc <<EOF
{
  "name": "gtfs-view-bus-pipeline",
  "main": "$(pwd)/src/index.ts",
  "compatibility_date": "2026-06-01",
  "triggers": { "crons": ["0 20 L * *"] },
  "r2_buckets": [
    { "binding": "DATA_BUCKET", "bucket_name": "gtfs-view-bus-data", "remote": true }
  ],
  "vars": { "GTFS_PREF_ID": "10" }
}
EOF

set -a
source ../.env
set +a
WRANGLER_LOG_PATH=.tmp/wrangler-logs pnpm exec wrangler dev \
  --config .tmp/wrangler-remote-r2.jsonc \
  --test-scheduled \
  --port 8791 \
  --show-interactive-dev-session false \
  --log-level info
```

別ターミナルでCronを発火する:

```bash
curl -fsS "http://127.0.0.1:8791/__scheduled?cron=0+20+L+*+*"
```

実行後、本番R2の `feeds.json` を取得して `generatedAt` とフィード件数を確認する:

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

アプリ側の `/data/*` は `cache-control: public, max-age=300` のため、R2更新後の画面反映には最大5分程度かかる。

## デプロイ

1. `infra/` で R2 バケットを作成(infra/README.md 参照)
2. GitHub Environment `production` に `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` を設定
3. main へマージすると GitHub Actions がデプロイ
4. 初回はデータが空なので、上記「本番R2を一度だけ更新する」の手順でデータを投入する

## ライセンス・出典

- バスデータ: GTFSデータリポジトリ(gtfs-data.jp)および公共交通オープンデータセンター(ODPT)の各事業者フィード(CC BY 4.0 等、feeds.json に記載)
- 地図タイル: © OpenStreetMap contributors
