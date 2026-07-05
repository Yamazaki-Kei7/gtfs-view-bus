# infra

Cloudflare のアカウントレベルリソース(R2バケット)を Terraform で管理する。
Worker 本体の設定・デプロイは各パッケージの wrangler.jsonc + GitHub Actions が担う。

## 事前準備

- Cloudflare API トークン(R2 編集権限)を作成し、環境変数に設定:
  `export CLOUDFLARE_API_TOKEN=...`
- アカウントIDは Cloudflare ダッシュボードの右下(またはURL)から取得

## 実行

```bash
cd infra
terraform init
terraform plan -var cloudflare_account_id=<ACCOUNT_ID>
terraform apply -var cloudflare_account_id=<ACCOUNT_ID>
```

state はローカル管理(PoC)。チーム運用に移行する場合はリモートバックエンドを検討する。
