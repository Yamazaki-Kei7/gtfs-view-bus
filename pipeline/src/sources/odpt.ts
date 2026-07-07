import type { FeedSource, FeedTarget } from './types';

interface OdptFeedDef {
	operator: string;
	feed: string;
	name: string;
	orgName: string;
}

/**
 * 配信対象のODPTフィード一覧。ODPTには県別一覧APIが無いためハードコードする。
 * 全フィード CC BY 4.0(各CKANデータセットページ https://ckan.odpt.org/ に明記)。
 * 選定根拠は docs/superpowers/specs/2026-07-06-odpt-datasource-design.md を参照。
 */
export const ODPT_FEEDS: OdptFeedDef[] = [
	{ operator: 'TakasakiCity', feed: 'yosiibus', name: 'よしいバス', orgName: '高崎市' },
	{ operator: 'GunmaBus', feed: 'AllLines', name: '群馬バス(全路線)', orgName: '群馬バス' },
	{
		operator: 'GunmachuoBus',
		feed: 'AllLines',
		name: '群馬中央バス(全路線)',
		orgName: '群馬中央バス',
	},
	{
		operator: 'JoshinKankoBus',
		feed: 'AllLines',
		name: '上信観光バス(全路線)',
		orgName: '上信観光バス',
	},
	{
		operator: 'JoshinHire',
		feed: 'AllLines',
		name: '上信ハイヤー(全路線)',
		orgName: '上信ハイヤー',
	},
	{
		operator: 'Kan_etsuTransportation',
		feed: 'AllLines',
		name: '関越交通(全路線)',
		orgName: '関越交通',
	},
	{
		operator: 'NipponChuoBus',
		feed: 'Maebashi_Area',
		name: '日本中央バス(前橋エリア)',
		orgName: '日本中央バス',
	},
	{
		operator: 'NagaiTransportation',
		feed: 'AllLines',
		name: '永井運輸(全路線)',
		orgName: '永井運輸',
	},
];

const API_BASE = 'https://api-public.odpt.org/api/v4/files/odpt';

function zipUrl(def: OdptFeedDef): string {
	return `${API_BASE}/${def.operator}/${def.feed}.zip?date=current`;
}

async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * versionId(と200直返し時のみzip本体)を解決する。
 * 302のLocationパスにはデータ版数入りのファイル名が含まれるため、
 * zip本体をダウンロードせずに更新有無を判定できる。
 */
async function resolveVersion(fetcher: typeof fetch, def: OdptFeedDef): Promise<string> {
	const res = await fetcher(zipUrl(def), { redirect: 'manual' });
	if (res.status >= 300 && res.status < 400) {
		const loc = res.headers.get('location');
		if (!loc) throw new Error(`redirect without location: ${def.operator}/${def.feed}`);
		return new URL(loc, API_BASE).pathname;
	}
	if (res.ok) {
		// リダイレクトを挟まない構成に変わった場合: 本体のハッシュを版数とする
		const body = new Uint8Array(await res.arrayBuffer());
		return sha256Hex(body);
	}
	throw new Error(`odpt zip fetch failed: ${res.status} (${def.operator}/${def.feed})`);
}

/** 公共交通オープンデータセンター(ODPT)のファイルAPIをFeedSourceへ適合させる */
export function createOdptSource(): FeedSource {
	return {
		sourceId: 'odpt',
		async listTargets(fetcher) {
			const descriptors: FeedTarget[] = [];
			for (const def of ODPT_FEEDS) {
				const base = {
					id: `odpt~${def.operator}~${def.feed}`,
					name: def.name,
					orgName: def.orgName,
					license: 'CC BY 4.0',
					fromDate: '',
					toDate: '',
					source: 'odpt' as const,
					zipUrl: zipUrl(def),
				};
				try {
					const versionId = await resolveVersion(fetcher, def);
					descriptors.push({
						...base,
						versionId,
					});
				} catch (e) {
					// 版数解決に失敗したフィードはメインループのフィード単位エラー処理に載せるため残す
					descriptors.push({
						...base,
						versionId: '',
					});
				}
			}
			return descriptors;
		},
	};
}
