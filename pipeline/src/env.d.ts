// wrangler types が生成する Env(worker-configuration.d.ts)へのプロジェクト固有の拡張。
// シークレットは wrangler.jsonc に現れないため、ここで宣言をマージする。
interface Env {
	/** ODPT開発者キー(任意)。設定時のみ api.odpt.org 配布フィードを処理対象に含める。
	 *  本番: `wrangler secret put ODPT_CONSUMER_KEY` / ローカル: `pipeline/.dev.vars` */
	ODPT_CONSUMER_KEY?: string;
	/** GTFS変換を実行する Cloudflare Container Durable Object binding */
	FEED_PROCESSOR_CONTAINER: DurableObjectNamespace;
}
