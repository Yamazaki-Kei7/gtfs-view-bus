export type RegionName = '北海道' | '東北' | '関東' | '中部' | '近畿' | '中国' | '四国' | '九州';

export interface PrefectureInfo {
	/** JIS 都道府県コード(1〜47) */
	id: number;
	/** 和名(セレクタ表示用) */
	ja: string;
	/** 地方区分 */
	region: RegionName;
}

export const REGIONS: readonly RegionName[] = [
	'北海道',
	'東北',
	'関東',
	'中部',
	'近畿',
	'中国',
	'四国',
	'九州',
];

export const PREFECTURES: readonly PrefectureInfo[] = [
	{ id: 1, ja: '北海道', region: '北海道' },
	{ id: 2, ja: '青森県', region: '東北' },
	{ id: 3, ja: '岩手県', region: '東北' },
	{ id: 4, ja: '宮城県', region: '東北' },
	{ id: 5, ja: '秋田県', region: '東北' },
	{ id: 6, ja: '山形県', region: '東北' },
	{ id: 7, ja: '福島県', region: '東北' },
	{ id: 8, ja: '茨城県', region: '関東' },
	{ id: 9, ja: '栃木県', region: '関東' },
	{ id: 10, ja: '群馬県', region: '関東' },
	{ id: 11, ja: '埼玉県', region: '関東' },
	{ id: 12, ja: '千葉県', region: '関東' },
	{ id: 13, ja: '東京都', region: '関東' },
	{ id: 14, ja: '神奈川県', region: '関東' },
	{ id: 15, ja: '新潟県', region: '中部' },
	{ id: 16, ja: '富山県', region: '中部' },
	{ id: 17, ja: '石川県', region: '中部' },
	{ id: 18, ja: '福井県', region: '中部' },
	{ id: 19, ja: '山梨県', region: '中部' },
	{ id: 20, ja: '長野県', region: '中部' },
	{ id: 21, ja: '岐阜県', region: '中部' },
	{ id: 22, ja: '静岡県', region: '中部' },
	{ id: 23, ja: '愛知県', region: '中部' },
	{ id: 24, ja: '三重県', region: '近畿' },
	{ id: 25, ja: '滋賀県', region: '近畿' },
	{ id: 26, ja: '京都府', region: '近畿' },
	{ id: 27, ja: '大阪府', region: '近畿' },
	{ id: 28, ja: '兵庫県', region: '近畿' },
	{ id: 29, ja: '奈良県', region: '近畿' },
	{ id: 30, ja: '和歌山県', region: '近畿' },
	{ id: 31, ja: '鳥取県', region: '中国' },
	{ id: 32, ja: '島根県', region: '中国' },
	{ id: 33, ja: '岡山県', region: '中国' },
	{ id: 34, ja: '広島県', region: '中国' },
	{ id: 35, ja: '山口県', region: '中国' },
	{ id: 36, ja: '徳島県', region: '四国' },
	{ id: 37, ja: '香川県', region: '四国' },
	{ id: 38, ja: '愛媛県', region: '四国' },
	{ id: 39, ja: '高知県', region: '四国' },
	{ id: 40, ja: '福岡県', region: '九州' },
	{ id: 41, ja: '佐賀県', region: '九州' },
	{ id: 42, ja: '長崎県', region: '九州' },
	{ id: 43, ja: '熊本県', region: '九州' },
	{ id: 44, ja: '大分県', region: '九州' },
	{ id: 45, ja: '宮崎県', region: '九州' },
	{ id: 46, ja: '鹿児島県', region: '九州' },
	{ id: 47, ja: '沖縄県', region: '九州' },
];

const PREF_BY_ID = new Map(PREFECTURES.map((p) => [p.id, p]));

/** id から都道府県情報を引く(不正 id は undefined) */
export function prefectureById(id: number): PrefectureInfo | undefined {
	return PREF_BY_ID.get(id);
}
