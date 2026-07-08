import manifestJson from './odptManifest.json';
import type { OdptManifestEntry, OdptManifestFile } from './odptManifestTypes';
import type { FeedSource, FeedTarget } from './types';

const ODPT_MANIFEST = manifestJson as OdptManifestFile;

async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function resolveVersion(fetcher: typeof fetch, entry: OdptManifestEntry): Promise<string> {
	const res = await fetcher(entry.zipUrl, { redirect: 'manual' });
	if (res.status >= 300 && res.status < 400) {
		const loc = res.headers.get('location');
		if (!loc) throw new Error(`redirect without location: ${entry.operator}/${entry.feed}`);
		return new URL(loc, entry.zipUrl).pathname;
	}
	if (res.ok) {
		return sha256Hex(new Uint8Array(await res.arrayBuffer()));
	}
	throw new Error(`odpt zip fetch failed: ${res.status} (${entry.operator}/${entry.feed})`);
}

function targetBase(entry: OdptManifestEntry): Omit<FeedTarget, 'versionId'> {
	return {
		id: `odpt~${entry.operator}~${entry.feed}`,
		name: entry.name,
		orgName: entry.orgName,
		license: entry.license,
		fromDate: entry.fromDate,
		toDate: entry.toDate,
		source: 'odpt',
		zipUrl: entry.zipUrl,
		prefId: entry.prefId ?? null,
	};
}

export interface OdptSourceOptions {
	/** acl:consumerKey が必要な api.odpt.org 配布フィードも対象に含める(キー設定時のみ true にする) */
	includeKeyRequired?: boolean;
}

/** 公共交通オープンデータセンター(ODPT)の静的マニフェストをFeedSourceへ適合させる */
export function createOdptSource(
	manifest: OdptManifestFile = ODPT_MANIFEST,
	options: OdptSourceOptions = {},
): FeedSource {
	return {
		sourceId: 'odpt',
		async listTargets(fetcher) {
			const targets: FeedTarget[] = [];
			for (const entry of manifest.feeds) {
				if (entry.requiresKey && !options.includeKeyRequired) continue;
				const base = targetBase(entry);
				try {
					targets.push({ ...base, versionId: await resolveVersion(fetcher, entry) });
				} catch {
					targets.push({ ...base, versionId: '' });
				}
			}
			return targets;
		},
	};
}

/**
 * api.odpt.org(開発者キー必須の配布ホスト)へのリクエストにだけ acl:consumerKey を付与する
 * fetcher を返す。キーを manifest・Queueメッセージ・R2 に保存せず、取得の瞬間だけ注入するための
 * ラッパー。キー未設定なら元の fetcher をそのまま返す(public のみの現行動作)。
 * キー名のコロンを ODPT の例示どおり保つため、URLSearchParams でなく文字列結合で付ける。
 */
export function withOdptConsumerKey(
	fetcher: typeof fetch,
	consumerKey: string | undefined,
): typeof fetch {
	if (!consumerKey) return fetcher;
	const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		if (typeof input === 'string' || input instanceof URL) {
			const url = String(input);
			if (new URL(url).hostname === 'api.odpt.org') {
				const sep = url.includes('?') ? '&' : '?';
				return fetcher(`${url}${sep}acl:consumerKey=${encodeURIComponent(consumerKey)}`, init);
			}
		}
		return fetcher(input, init);
	};
	return impl as typeof fetch;
}
