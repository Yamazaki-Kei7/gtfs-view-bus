export type BasemapKey = 'osm' | 'positron' | 'voyager';

export interface BasemapDef {
	/** セレクタボタンのtitle属性用フルラベル */
	label: string;
	/** セレクタボタンに表示する短縮ラベル */
	short: string;
	tiles: string[];
	maxzoom: number;
	attribution: string;
}

const OSM_ATTRIBUTION = '© OpenStreetMap contributors';
const CARTO_ATTRIBUTION = '© OpenStreetMap contributors © CARTO';

// MapLibreのraster sourceは{s}サブドメイン置換に対応しないため、a/b/c/dを事前展開したURL配列を渡す
function cartoRasterTiles(path: string): string[] {
	return ['a', 'b', 'c', 'd'].map(
		(s) => `https://${s}.basemaps.cartocdn.com/${path}/{z}/{x}/{y}.png`,
	);
}

export const BASEMAPS: Record<BasemapKey, BasemapDef> = {
	osm: {
		label: 'OpenStreetMap(標準)',
		short: 'OSM',
		tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
		maxzoom: 19,
		attribution: OSM_ATTRIBUTION,
	},
	positron: {
		label: 'Carto Positron(淡色)',
		short: 'Positron',
		tiles: cartoRasterTiles('light_all'),
		maxzoom: 20,
		attribution: CARTO_ATTRIBUTION,
	},
	voyager: {
		label: 'Carto Voyager(道路強調)',
		short: 'Voyager',
		tiles: cartoRasterTiles('rastertiles/voyager'),
		maxzoom: 20,
		attribution: CARTO_ATTRIBUTION,
	},
};

export const BASEMAP_KEYS: BasemapKey[] = ['osm', 'positron', 'voyager'];
