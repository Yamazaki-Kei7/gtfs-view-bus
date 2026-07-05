/** テスト用の極小GTFSフィード(L字路線1本・停留所3つ・平日運行・深夜便あり) */
export const FIXTURE_FILES: Record<string, string> = {
	'stops.txt': `stop_id,stop_name,stop_lat,stop_lon
A,駅前,36.0000,139.0000
B,中央,36.0001,139.0050
C,公園,36.0100,139.0100
`,
	'routes.txt': `route_id,route_short_name,route_long_name,route_color
R1,1,駅前線,FF0000
R2,2,循環線,0000FF
`,
	'trips.txt': `route_id,service_id,trip_id,shape_id
R1,WD,T1,S1
R1,WD,T2,
R2,WD,T3,
`,
	'stop_times.txt': `trip_id,arrival_time,departure_time,stop_id,stop_sequence
T1,08:00:00,08:00:00,A,1
T1,08:10:00,08:11:00,B,2
T1,08:30:00,08:30:00,C,3
T2,24:50:00,24:50:00,A,1
T2,25:00:00,25:00:00,B,2
T2,25:20:00,25:20:00,C,3
T3,09:00:00,09:00:00,A,1
T3,09:10:00,09:10:00,B,2
T3,09:30:00,09:30:00,C,3
`,
	'shapes.txt': `shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence
S1,36.0000,139.0000,1
S1,36.0000,139.0100,2
S1,36.0100,139.0100,3
`,
	'calendar.txt': `service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
WD,1,1,1,1,1,0,0,20260401,20270331
`,
	'calendar_dates.txt': `date,service_id,exception_type
20260713,WD,2
20260712,WD,1
`,
};

/** R2 の道路形状: L字を0.001度刻みで密にした頂点列(shapes.txt なしフィードの代替形状源) */
const r2RoadCoords: [number, number][] = [
	...Array.from({ length: 11 }, (_, i): [number, number] => [139.0 + i * 0.001, 36.0]),
	...Array.from({ length: 10 }, (_, i): [number, number] => [139.01, 36.001 + i * 0.001]),
];

/** リポジトリ提供の routes.geojson を模したフィクスチャ(properties.id = route_id) */
export const FIXTURE_ROUTES_GEOJSON = JSON.stringify({
	type: 'FeatureCollection',
	features: [
		{
			type: 'Feature',
			properties: { id: 'R2', route_name: '循環線' },
			geometry: { type: 'MultiLineString', coordinates: [r2RoadCoords] },
		},
	],
});
