# gtfs-view-bus

群馬県のGTFSフィード(gtfs-data.jp)をもとに、指定日時のバス推定位置を地図上に表示するWebGIS。

- 設計書: `docs/superpowers/specs/2026-07-05-gtfs-bus-position-webgis-design.md`
- 実装計画: `docs/superpowers/plans/2026-07-05-gtfs-bus-position-webgis.md`
- 構成: `pipeline/`(月次変換Worker) → R2 → `app/`(SvelteKit on Workers) → MapLibre
- 共有ロジック: `packages/gtfs-core/`(CSVパース・shape射影・キーフレーム補間・カレンダー判定)
- IaC: `infra/`(Terraform, R2バケット) + 各 `wrangler.jsonc`

## 開発

```bash
pnpm install
pnpm -r run test

# ローカルR2にデータ投入(初回のみ)
cd pipeline && pnpm dev
# 別ターミナルで: curl "http://localhost:8787/__scheduled?cron=0+20+L+*+*"

# フロント起動
pnpm --filter app dev
```

Node 22 以上 + pnpm 10 を使用する。

## デプロイ

1. `infra/` で R2 バケットを作成(infra/README.md 参照)
2. GitHub Environment `production` に `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` を設定
3. main へマージすると GitHub Actions がデプロイ
4. 初回はデータが空なので、Cloudflare ダッシュボード → Workers → gtfs-view-bus-pipeline →
   Settings → Trigger Events から Cron を手動実行してデータを投入する

## ライセンス・出典

- バスデータ: GTFSデータリポジトリ(gtfs-data.jp)の各事業者フィード(CC BY 4.0 等、feeds.json に記載)
- 地図タイル: © OpenStreetMap contributors
