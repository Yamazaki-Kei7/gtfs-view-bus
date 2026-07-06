<script lang="ts">
	import {
		CircleLayer,
		GeoJSONSource,
		GeolocateControl,
		LineLayer,
		MapLibre,
		NavigationControl,
		Popup,
	} from 'svelte-maplibre-gl';
	import type {
		CircleLayerSpecification,
		ExpressionSpecification,
		Map as MaplibreMap,
		StyleSpecification,
	} from 'maplibre-gl';
	import { busFeatureCollection, routeCatalog, type LngLat } from 'gtfs-core';
	import Controls from '$lib/Controls.svelte';
	import RouteLayers from '$lib/RouteLayers.svelte';
	import { buildRouteLines, loadAll, type LoadedData, type RouteLineCollection } from '$lib/data';
	import { MAX_TIME_SEC, sim } from '$lib/sim.svelte';

	// OSMベースマップは初期スタイルに含める(RasterTileSource コンポーネント経由だと
	// タイルが読み込まれない事象があるため、スタイルオブジェクトで確実に描画する)
	const BASE_STYLE: StyleSpecification = {
		version: 8,
		sources: {
			osm: {
				type: 'raster',
				tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
				tileSize: 256,
				maxzoom: 19,
				attribution: '© OpenStreetMap contributors',
			},
		},
		layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
	};

	// 路線色・停留所半径はデータ駆動式で指定する。停留所は minzoom(下記)以上でのみ表示する
	const ROUTE_COLOR_EXPR: ExpressionSpecification = ['get', 'color'];
	// 停留所を表示する最小ズーム(これ未満では非表示にして俯瞰時の煩雑さを避ける)
	const STOP_MIN_ZOOM = 12;
	const STOP_RADIUS_EXPR: ExpressionSpecification = [
		'interpolate',
		['linear'],
		['zoom'],
		12,
		4,
		16,
		8,
	];

	let map = $state<MaplibreMap | undefined>();
	let data = $state<LoadedData | null>(null);
	let loadError = $state<string | null>(null);
	// trip_id はフィード内でのみ一意なので、選択キーは feedId と組み合わせる
	let selectedKey = $state<string | null>(null);
	// 非表示にした路線(key = `${feedId}|${routeId}`)
	let hidden = $state<Record<string, boolean>>({});
	// バスの脈動アニメーションの位相(0〜1のこぎり波)
	let pulse = $state(0);

	$effect(() => {
		loadAll()
			.then((d) => (data = d))
			.catch((e: Error) => (loadError = e.message));
	});

	const dateYMD = $derived(sim.date.replaceAll('-', ''));

	const catalog = $derived(data ? routeCatalog(data.feeds, dateYMD) : []);
	const activeRoutes = $derived(catalog.filter((r) => r.active));
	const colorByKey = $derived(new Map(catalog.map((r) => [r.key, r.color])));

	// 地図パネルのヘッダに出す日付ラベル(M/D(曜))
	const dateLabel = $derived.by(() => {
		const [y, m, d] = sim.date.split('-').map(Number);
		const w = ['日', '月', '火', '水', '木', '金', '土'][
			new Date(Date.UTC(y, m - 1, d)).getUTCDay()
		];
		return `${m}/${d}(${w})`;
	});

	const EMPTY_LINES: RouteLineCollection = { type: 'FeatureCollection', features: [] };
	const routeLines = $derived(data ? buildRouteLines(data.feeds, catalog, hidden) : EMPTY_LINES);
	// 停留所レイヤはデータ読込前でも宣言順どおりの重なり(路線ライン→バス停→バス)で
	// マウントさせるため、常設し空FCで初期化する({#if data}だと後付けでバスの上に乗る)
	const EMPTY_STOPS: LoadedData['stops'] = { type: 'FeatureCollection', features: [] };

	interface ColoredBusFeature {
		type: 'Feature';
		geometry: { type: 'Point'; coordinates: LngLat };
		properties: { feedId: string; tripId: string; routeName: string; color: string };
	}
	interface ColoredBusCollection {
		type: 'FeatureCollection';
		features: ColoredBusFeature[];
	}

	// バス位置を計算し、非表示路線を除外して所属路線の色を付与する
	const buses = $derived.by((): ColoredBusCollection => {
		if (!data) return { type: 'FeatureCollection', features: [] };
		const fc = busFeatureCollection(data.feeds, dateYMD, sim.timeSec);
		const features: ColoredBusFeature[] = [];
		for (const f of fc.features) {
			const routeKey = `${f.properties.feedId}|${f.properties.routeId}`;
			if (hidden[routeKey]) continue;
			features.push({
				type: 'Feature',
				geometry: f.geometry,
				properties: {
					feedId: f.properties.feedId,
					tripId: f.properties.tripId,
					routeName: f.properties.routeName,
					color: colorByKey.get(routeKey) ?? '#e11d48',
				},
			});
		}
		return { type: 'FeatureCollection', features };
	});

	// ポップアップはクリック時のスナップショットではなく毎フレームの最新位置に追随させる
	// (便が運行を終えたり日付が変わったら自動的に閉じる)
	const selectedBus = $derived(
		selectedKey
			? (buses.features.find(
					(f) => `${f.properties.feedId}|${f.properties.tripId}` === selectedKey,
				) ?? null)
			: null,
	);

	function toggleRoute(key: string) {
		hidden = { ...hidden, [key]: !hidden[key] };
	}

	// 脈動アニメーション(波紋リング + 本体の呼吸)
	const busPulsePaint: CircleLayerSpecification['paint'] = $derived({
		'circle-radius': 7 + pulse * 13,
		'circle-color': ROUTE_COLOR_EXPR,
		'circle-opacity': 0.4 * (1 - pulse),
		'circle-stroke-width': 0,
	});
	const busCorePaint: CircleLayerSpecification['paint'] = $derived({
		'circle-radius': 7 + Math.sin(pulse * Math.PI * 2) * 1.2,
		'circle-color': ROUTE_COLOR_EXPR,
		'circle-stroke-width': 2,
		'circle-stroke-color': '#ffffff',
	});

	$effect(() => {
		let raf = 0;
		let start: number | null = null;
		const PERIOD = 1600;
		const tick = (now: number) => {
			if (start === null) start = now;
			pulse = ((now - start) % PERIOD) / PERIOD;
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	});

	// 非表示タブ/プリレンダリング中に初期化されると初回描画が抜けることがあるため、
	// マウント直後と再表示時に resize で再描画を促す
	$effect(() => {
		if (!map) return;
		const kick = () => map?.resize();
		const t = setTimeout(kick, 100);
		document.addEventListener('visibilitychange', kick);
		return () => {
			clearTimeout(t);
			document.removeEventListener('visibilitychange', kick);
		};
	});

	// 再生ループ: 実時間 dt 秒 → シミュレーション dt×speed 秒
	$effect(() => {
		if (!sim.playing) return;
		let raf = 0;
		let last = performance.now();
		const tick = (now: number) => {
			sim.timeSec = Math.min(sim.timeSec + ((now - last) / 1000) * sim.speed, MAX_TIME_SEC);
			last = now;
			if (sim.timeSec >= MAX_TIME_SEC) {
				sim.playing = false;
			} else {
				raf = requestAnimationFrame(tick);
			}
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	});
</script>

<div class="relative h-screen w-screen">
	<MapLibre
		bind:map
		class="h-full w-full"
		style={BASE_STYLE}
		center={[139.2, 36.35]}
		zoom={10}
		attributionControl={false}
	>
		<NavigationControl showCompass={false} position="top-right" />
		<GeolocateControl
			position="top-right"
			positionOptions={{ enableHighAccuracy: true }}
			trackUserLocation
			showUserLocation
			showAccuracyCircle
			fitBoundsOptions={{ maxZoom: 15 }}
		/>

		<GeoJSONSource data={routeLines}>
			<LineLayer
				layout={{ 'line-cap': 'round', 'line-join': 'round' }}
				paint={{ 'line-color': ROUTE_COLOR_EXPR, 'line-width': 3, 'line-opacity': 0.75 }}
			/>
		</GeoJSONSource>

		<GeoJSONSource data={data ? data.stops : EMPTY_STOPS}>
			<CircleLayer
				minzoom={STOP_MIN_ZOOM}
				paint={{
					'circle-radius': STOP_RADIUS_EXPR,
					'circle-color': '#6e848d',
					'circle-stroke-width': 1.5,
					'circle-stroke-color': '#ffffff',
				}}
			/>
		</GeoJSONSource>

		<GeoJSONSource data={buses}>
			<CircleLayer paint={busPulsePaint} />
			<CircleLayer
				paint={busCorePaint}
				onclick={(ev) => {
					const f = ev.features?.[0];
					if (f && f.geometry.type === 'Point') {
						selectedKey = `${String(f.properties.feedId)}|${String(f.properties.tripId)}`;
					}
				}}
			/>
		</GeoJSONSource>

		{#if selectedBus}
			<Popup lnglat={selectedBus.geometry.coordinates} onclose={() => (selectedKey = null)}>
				<div class="text-sm">
					<div class="font-bold text-mi-slate-900">{selectedBus.properties.routeName}</div>
					<div class="text-mi-slate-600">便: {selectedBus.properties.tripId}</div>
				</div>
			</Popup>
		{/if}
	</MapLibre>

	{#if loadError}
		<div
			class="absolute top-4 left-1/2 z-10 -translate-x-1/2 rounded-[10px] bg-mi-ember-600 px-4 py-2 text-white shadow-lg"
		>
			{loadError}
		</div>
	{/if}
	{#if data && buses.features.length === 0}
		<div
			class="absolute top-4 left-1/2 z-10 -translate-x-1/2 rounded-[10px] bg-mi-teal-900/90 px-4 py-2 text-sm text-white shadow-lg"
		>
			この日時に運行中のバスはありません(日付がダイヤの有効期間外の可能性があります)
		</div>
	{/if}

	{#if data}
		<RouteLayers routes={activeRoutes} {hidden} onToggle={toggleRoute} {dateLabel} />
	{/if}
	<Controls busCount={buses.features.length} feedInfos={data?.index.feeds ?? []} />
</div>
