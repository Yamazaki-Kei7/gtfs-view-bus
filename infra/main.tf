terraform {
  required_version = ">= 1.7"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

# 認証は環境変数 CLOUDFLARE_API_TOKEN を使う
provider "cloudflare" {}

resource "cloudflare_r2_bucket" "data" {
  account_id = var.cloudflare_account_id
  name       = "gtfs-view-bus-data"
  location   = "APAC"
}
