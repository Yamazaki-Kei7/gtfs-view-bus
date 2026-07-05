# gtfs-view-bus

群馬県のGTFSフィード(gtfs-data.jp)をもとに、指定日時のバス推定位置を地図上に表示するWebGIS。

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

## デプロイ

1. `infra/` で R2 バケットを作成(infra/README.md 参照)
2. GitHub Environment `production` に `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` を設定
3. main へマージすると GitHub Actions がデプロイ
4. 初回はデータが空なので、Cloudflare ダッシュボード → Workers → gtfs-view-bus-pipeline →
   Settings → Trigger Events から Cron を手動実行してデータを投入する

## ライセンス・出典

- バスデータ: GTFSデータリポジトリ(gtfs-data.jp)の各事業者フィード(CC BY 4.0 等、feeds.json に記載)
- 地図タイル: © OpenStreetMap contributors
