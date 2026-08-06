import manifestJson from './busKyoManifest.json';
import type { FeedSource, FeedTarget } from './types';

interface BusKyoEntry {
	/** R2キーに使う安定スラグ。URL・名称が変わっても不変にする */
	key: string;
	name: string;
	zipUrl: string;
}

const MANIFEST = manifestJson as BusKyoEntry[];
/** JIS 都道府県コード: 広島県 */
const PREF_HIROSHIMA = 34;

function toTarget(entry: BusKyoEntry): FeedTarget {
	return {
		id: `bus-kyo~${entry.key}`,
		name: entry.name,
		orgName: entry.name,
		license: 'CC0',
		fromDate: '',
		toDate: '',
		source: 'bus-kyo',
		// listing にバージョン情報が無いため空文字にし、feedProcessor に毎回再処理させる
		versionId: '',
		zipUrl: entry.zipUrl,
		prefId: PREF_HIROSHIMA,
	};
}

/** 広島県バス協会 GTFSオープンデータの固定17事業者を FeedTarget へ写像する。
 *  機械可読カタログが無いため、リポジトリ内マニフェストを唯一の情報源にする。 */
export function createBusKyoSource(): FeedSource {
	return {
		sourceId: 'bus-kyo',
		listTargets: async () => MANIFEST.map(toTarget),
	};
}
