export type BasemapKey = 'osm' | 'gsi-pale' | 'gsi-std';

export interface BasemapDef {
	/** セレクタボタンのtitle属性用フルラベル */
	label: string;
	/** セレクタボタンに表示する短縮ラベル */
	short: string;
	tiles: string[];
	maxzoom: number;
	attribution: string;
	attributionUrl: string;
}

const OSM_ATTRIBUTION = '© OpenStreetMap contributors';
const GSI_ATTRIBUTION = '国土地理院';
const GSI_ATTRIBUTION_URL = 'https://maps.gsi.go.jp/development/ichiran.html';

export const BASEMAPS: Record<BasemapKey, BasemapDef> = {
	osm: {
		label: 'OpenStreetMap(標準)',
		short: 'OSM',
		tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
		maxzoom: 19,
		attribution: OSM_ATTRIBUTION,
		attributionUrl: 'https://www.openstreetmap.org/copyright',
	},
	// CARTOはAPIキー必須になったため、キーなしで利用できる地理院タイルを使う。
	'gsi-pale': {
		label: '国土地理院(淡色地図)',
		short: '淡色地図',
		tiles: ['https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png'],
		maxzoom: 18,
		attribution: GSI_ATTRIBUTION,
		attributionUrl: GSI_ATTRIBUTION_URL,
	},
	'gsi-std': {
		label: '国土地理院(標準地図)',
		short: '標準地図',
		tiles: ['https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png'],
		maxzoom: 18,
		attribution: GSI_ATTRIBUTION,
		attributionUrl: GSI_ATTRIBUTION_URL,
	},
};

export const BASEMAP_KEYS: BasemapKey[] = ['osm', 'gsi-pale', 'gsi-std'];
