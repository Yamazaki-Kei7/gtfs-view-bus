<script lang="ts">
	import { onMount } from 'svelte';
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
		MapLayerMouseEvent,
		Map as MaplibreMap,
		StyleSpecification,
	} from 'maplibre-gl';
	import {
		buildStopTimetable,
		busFeatureCollection,
		prefectureById,
		routeCatalog,
		type BusFeature,
		type GeneratedFeatureCollection,
		type StopTimetable as StopTimetableData,
		type TimetableIndex,
	} from 'gtfs-core';
	import Controls from '$lib/Controls.svelte';
	import RouteLayers from '$lib/RouteLayers.svelte';
	import StopTimetable from '$lib/StopTimetable.svelte';
	import BasemapControl from '$lib/BasemapControl.svelte';
	import PrefecturePicker, { JAPAN_BOUNDS } from '$lib/PrefecturePicker.svelte';
	import PrefectureHeader from '$lib/PrefectureHeader.svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import {
		buildRouteLines,
		loadIndex,
		loadPrefecture,
		loadAllFeeds,
		prefectureCounts,
		loadTimetable,
		type FeedIndex,
		type LoadedData,
		type RouteLineCollection,
		type StopFeature,
	} from '$lib/data';
	import { BASEMAPS, type BasemapKey } from '$lib/basemaps';
	import { MAX_TIME_SEC, nowJst, sim } from '$lib/sim.svelte';

	// 背景ラスタは初期スタイルに含める(RasterTileSource コンポーネント経由だと
	// タイルが読み込まれない事象があるため、スタイルオブジェクトで確実に描画する)。
	// 切替時はこのstyleを再代入せず、map への直接操作で base ソース/レイヤだけを差し替える(setBasemap参照)。
	function baseStyle(key: BasemapKey): StyleSpecification {
		const bm = BASEMAPS[key];
		return {
			version: 8,
			sources: {
				base: {
					type: 'raster',
					tiles: bm.tiles,
					tileSize: 256,
					maxzoom: bm.maxzoom,
					attribution: bm.attribution,
				},
			},
			layers: [{ id: 'base', type: 'raster', source: 'base' }],
		};
	}
	const INITIAL_BASEMAP: BasemapKey = 'positron';
	const BASE_STYLE = baseStyle(INITIAL_BASEMAP);

	// 路線色はデータ駆動式で指定する
	const ROUTE_COLOR_EXPR: ExpressionSpecification = ['get', 'color'];
	// 停留所を表示する最小ズーム(これ未満では非表示にして俯瞰時の煩雑さを避ける)
	const STOP_MIN_ZOOM = 12;
	// 運行中停留所: 白抜き + 路線色リング(ラインの視認を妨げない)
	const STOP_ACTIVE_RADIUS: ExpressionSpecification = [
		'interpolate',
		['linear'],
		['zoom'],
		12,
		2.5,
		16,
		5,
	];
	const STOP_ACTIVE_STROKE: ExpressionSpecification = [
		'interpolate',
		['linear'],
		['zoom'],
		12,
		1.2,
		16,
		2,
	];
	// 運休停留所: 小さいグレーの中実点(運行中と別シンボルにして目立たせない)
	const STOP_INACTIVE_RADIUS: ExpressionSpecification = [
		'interpolate',
		['linear'],
		['zoom'],
		12,
		2,
		16,
		3.5,
	];
	const STOP_INACTIVE_COLOR = '#aeb9bf';
	// 旧データ(routeIds 無し)フォールバックのリング色
	const STOP_NEUTRAL_COLOR = '#6e848d';
	// レイヤ filter は真偽式。get('active') で運行/運休を分離する
	const STOP_ACTIVE_FILTER: ExpressionSpecification = ['==', ['get', 'active'], true];
	const STOP_INACTIVE_FILTER: ExpressionSpecification = ['==', ['get', 'active'], false];
	const INACTIVE_ROUTE_FILTER: ExpressionSpecification = ['==', ['get', 'active'], false];

	let map = $state<MaplibreMap | undefined>();
	let basemap = $state<BasemapKey>(INITIAL_BASEMAP);

	// 背景ラスタを差し替える。style prop の再代入はレイヤ構成をリセットしうるため使わず、
	// map への直接操作で base ソース/レイヤだけを入れ替える(プロトタイプと同じ手法)。
	function setBasemap(key: BasemapKey) {
		basemap = key;
		if (!map) return;
		const bm = BASEMAPS[key];
		if (map.getLayer('base')) map.removeLayer('base');
		if (map.getSource('base')) map.removeSource('base');
		// 削除後のlayers[0]が現在の最下層(=baseを差し込むべき位置)になる
		const beforeId = map.getStyle().layers[0]?.id;
		map.addSource('base', {
			type: 'raster',
			tiles: bm.tiles,
			tileSize: 256,
			maxzoom: bm.maxzoom,
			attribution: bm.attribution,
		});
		map.addLayer({ id: 'base', type: 'raster', source: 'base' }, beforeId);
	}
	let data = $state<LoadedData | null>(null);
	let loadError = $state<string | null>(null);
	let index = $state<FeedIndex | null>(null);
	let prefLoading = $state(false);
	// prefId が全て null(旧feeds.json / 未投入)なら従来の全量表示にフォールバックする
	const hasPrefData = $derived(!!index && index.feeds.some((f) => f.prefId != null));
	const counts = $derived(index ? prefectureCounts(index) : new Map<number, number>());
	// 選択中の都道府県は URL クエリ ?pref を単一情報源にする
	const selectedPref = $derived.by(() => {
		const raw = page.url.searchParams.get('pref');
		const n = raw ? Number(raw) : NaN;
		return Number.isInteger(n) && (counts.get(n) ?? 0) > 0 ? n : null;
	});
	// 未選択かつ prefId データありのときだけコロプレスピッカーを表示する
	const showPicker = $derived(!!index && hasPrefData && selectedPref === null);
	// バス/路線の選択(排他)。判別共用体の単一状態にして排他性を表現そのものに担わせる。
	// bus の key は `${feedId}|${tripId}`(trip_id はフィード内でのみ一意)、route の key は `${feedId}|${routeId}`
	type Selection =
		{ kind: 'bus'; key: string } | { kind: 'route'; key: string; lnglat: [number, number] };
	let selected = $state<Selection | null>(null);
	// バス停クリックで開く時刻表。バス/路線ポップアップとは独立した選択状態
	let selectedStop = $state<{
		feedId: string;
		stopId: string;
		name: string;
		coord: [number, number];
	} | null>(null);
	// 遅延ロード済みのフィード別時刻表インデックス
	let timetableByFeed = $state<Record<string, TimetableIndex>>({});
	// 非表示にした路線(key = `${feedId}|${routeId}`)
	let hidden = $state<Record<string, boolean>>({});
	// バスの脈動アニメーションの位相(0〜1のこぎり波)
	let pulse = $state(0);
	// 地図カーソル(クリック可能なフィーチャ上で pointer にする)
	let cursor = $state('');

	onMount(() => {
		const n = nowJst();
		sim.date = n.date;
		sim.timeSec = n.timeSec;
	});

	// インデックス(feeds.json)を初回に取得する
	$effect(() => {
		loadIndex()
			.then((idx) => (index = idx))
			.catch((e: Error) => (loadError = e.message));
	});

	// 選択県(または prefId 無しなら全量)に応じてフィードデータをロードし直す。
	// 県を素早く切替えた際に古いロードが新しい選択を上書きしないよう、cleanup の disposed で在庫のロードを無効化する。
	$effect(() => {
		const idx = index;
		if (!idx) return;
		let disposed = false;
		// prefId 未投入 → 従来どおり全量表示にフォールバック
		if (!hasPrefData) {
			prefLoading = true;
			loadAllFeeds(idx)
				.then((d) => {
					if (!disposed) data = d;
				})
				.catch((e: Error) => {
					if (!disposed) loadError = e.message;
				})
				.finally(() => {
					if (!disposed) prefLoading = false;
				});
			return () => {
				disposed = true;
			};
		}
		const pref = selectedPref;
		if (pref === null) {
			// 未選択: ピッカー表示。前県の描画・状態・ローディングをクリアする
			data = null;
			prefLoading = false;
			hidden = {};
			selected = null;
			selectedStop = null;
			timetableByFeed = {};
			return;
		}
		prefLoading = true;
		loadPrefecture(pref, idx)
			.then((d) => {
				if (disposed) return;
				data = d;
				fitToStops(d);
			})
			.catch((e: Error) => {
				if (!disposed) loadError = e.message;
			})
			.finally(() => {
				if (!disposed) prefLoading = false;
			});
		return () => {
			disposed = true;
		};
	});

	// ロード済み県の停留所範囲へ地図を寄せる(県ポリゴンbboxは離島で巨大になるため使わない)。
	// maplibre-gl の値 import は SSR(CommonJS)で壊れるため、bbox は配列で組み立てて fitBounds に渡す。
	function fitToStops(d: LoadedData) {
		if (!map || d.stops.features.length === 0) return;
		let minLng = Infinity;
		let minLat = Infinity;
		let maxLng = -Infinity;
		let maxLat = -Infinity;
		for (const s of d.stops.features) {
			const [lng, lat] = s.geometry.coordinates;
			if (lng < minLng) minLng = lng;
			if (lat < minLat) minLat = lat;
			if (lng > maxLng) maxLng = lng;
			if (lat > maxLat) maxLat = lat;
		}
		map.fitBounds(
			[
				[minLng, minLat],
				[maxLng, maxLat],
			],
			{ padding: { top: 90, right: 60, bottom: 150, left: 60 }, maxZoom: 13, duration: 1200 },
		);
	}

	function selectPref(prefId: number) {
		// 現在ルート(/)のクエリのみ変更。resolve('/') 済みのベースにクエリを付与するため resolve 呼び出しの外に出る
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		goto(`${resolve('/')}?pref=${prefId}`, { keepFocus: true, noScroll: true });
	}
	function clearPref() {
		goto(resolve('/'), { keepFocus: true, noScroll: true });
	}

	const dateYMD = $derived(sim.date.replaceAll('-', ''));

	const catalog = $derived(data ? routeCatalog(data.feeds, dateYMD) : []);
	const activeRoutes = $derived(catalog.filter((r) => r.active));
	// key → RouteInfo(バスの色付け・路線ポップアップの表示内容をカタログから引く)
	const routeByKey = $derived(new Map(catalog.map((r) => [r.key, r])));

	// 地図パネルのヘッダに出す日付ラベル(M/D(曜))
	const dateLabel = $derived.by(() => {
		const [y, m, d] = sim.date.split('-').map(Number);
		const w = ['日', '月', '火', '水', '木', '金', '土'][
			new Date(Date.UTC(y, m - 1, d)).getUTCDay()
		];
		return `${m}/${d}(${w})`;
	});

	// 時刻表パネル(バス停クリック)の現在時刻ラベル(HH:MM)
	const timeLabel = $derived(
		`${String(Math.floor(sim.timeSec / 3600)).padStart(2, '0')}:${String(
			Math.floor((sim.timeSec % 3600) / 60),
		).padStart(2, '0')}`,
	);

	// 選択中バス停の時刻表(指定日にアクティブ・表示中の便のみ・路線ごとに方向分割)
	const stopTimetable = $derived.by((): StopTimetableData | null => {
		const sel = selectedStop;
		if (!sel || !data) return null;
		const idx = timetableByFeed[sel.feedId];
		if (!idx) return null; // timetable.json ロード中
		const feed = data.feeds.find((f) => f.id === sel.feedId);
		if (!feed) return null;
		return buildStopTimetable({
			entries: idx.stops[sel.stopId] ?? [],
			calendar: feed.bundle.calendar,
			date: dateYMD,
			nowSec: sim.timeSec,
			routeInfo: (routeId) => routeByKey.get(`${sel.feedId}|${routeId}`),
			isVisible: (routeId) => !hidden[`${sel.feedId}|${routeId}`],
		});
	});

	// 選択中バス停のハイライトリング(地図)
	const selectedStopFC = $derived({
		type: 'FeatureCollection' as const,
		features: selectedStop
			? [
					{
						type: 'Feature' as const,
						geometry: { type: 'Point' as const, coordinates: selectedStop.coord },
						properties: {},
					},
				]
			: [],
	});

	// バス停クリック: 時刻表を開き、そのフィードの時刻表インデックスを遅延ロードする
	function handleStopClick(ev: MapLayerMouseEvent) {
		// 上にバスが重なる場合はバスのポップアップを優先し、時刻表は開かない
		if (ev.target.queryRenderedFeatures(ev.point, { layers: ['buses'] }).length > 0) return;
		const f = ev.features?.[0];
		if (!f || f.geometry.type !== 'Point' || !f.properties) return;
		const feedId = String(f.properties.feedId);
		selectedStop = {
			feedId,
			stopId: String(f.properties.stopId),
			name: String(f.properties.name),
			coord: [f.geometry.coordinates[0], f.geometry.coordinates[1]],
		};
		if (!timetableByFeed[feedId]) {
			loadTimetable(feedId).then((idx) => {
				timetableByFeed = { ...timetableByFeed, [feedId]: idx };
			});
		}
	}

	const EMPTY_LINES: RouteLineCollection = { type: 'FeatureCollection', features: [] };
	const routeLines = $derived(data ? buildRouteLines(data.feeds, catalog) : EMPTY_LINES);
	// 表示する路線ライン = 当日運行(active) かつ 非表示でない
	const activeRouteFilter = $derived<ExpressionSpecification>([
		'all',
		['==', ['get', 'active'], true],
		['!', ['in', ['get', 'key'], ['literal', Object.keys(hidden).filter((k) => hidden[k])]]],
	]);

	// バス位置(gtfs-core の BusFeature)に所属路線の色を付与した Feature
	interface ColoredBusFeature extends BusFeature {
		properties: BusFeature['properties'] & { color: string };
	}
	type ColoredBusCollection = GeneratedFeatureCollection<ColoredBusFeature>;

	// バス位置を計算し、非表示路線を除外して所属路線の色を付与する
	const buses = $derived.by((): ColoredBusCollection => {
		if (!data) return { type: 'FeatureCollection', features: [] };
		const fc = busFeatureCollection(data.feeds, dateYMD, sim.timeSec);
		const features: ColoredBusFeature[] = [];
		for (const f of fc.features) {
			const routeKey = `${f.properties.feedId}|${f.properties.routeId}`;
			if (hidden[routeKey]) continue;
			features.push({
				...f,
				properties: { ...f.properties, color: routeByKey.get(routeKey)?.color ?? '#e11d48' },
			});
		}
		return { type: 'FeatureCollection', features };
	});

	// 描画用の停留所 Feature(active と色をカタログ・非表示状態から決める)
	interface RenderStopFeature {
		type: 'Feature';
		geometry: StopFeature['geometry'];
		properties: { stopId: string; name: string; feedId: string; active: boolean; color: string };
	}
	const stopFC = $derived.by((): GeneratedFeatureCollection<RenderStopFeature> => {
		if (!data) return { type: 'FeatureCollection', features: [] };
		const features: RenderStopFeature[] = [];
		for (const s of data.stops.features) {
			const { stopId, name, feedId, routeKeys } = s.properties;
			if (routeKeys === undefined) {
				// 旧データ: 路線関連付けが無い → 中立色で運行中表示(淡色化しない)
				features.push({
					type: 'Feature',
					geometry: s.geometry,
					properties: { stopId, name, feedId, active: true, color: STOP_NEUTRAL_COLOR },
				});
				continue;
			}
			let hasActiveRoute = false;
			let visibleColor: string | null = null;
			for (const k of routeKeys) {
				const info = routeByKey.get(k);
				if (!info?.active) continue;
				hasActiveRoute = true;
				if (!hidden[k] && visibleColor === null) visibleColor = info.color;
			}
			if (!hasActiveRoute) {
				// 当日運行路線が1本も通らない → 運休停留所(グレー点)
				features.push({
					type: 'Feature',
					geometry: s.geometry,
					properties: { stopId, name, feedId, active: false, color: STOP_INACTIVE_COLOR },
				});
			} else if (visibleColor !== null) {
				// 運行中かつ表示中の路線が通る → 白抜き + その路線色のリング
				features.push({
					type: 'Feature',
					geometry: s.geometry,
					properties: { stopId, name, feedId, active: true, color: visibleColor },
				});
			}
			// hasActiveRoute かつ visibleColor===null(運行路線が全て非表示)→ 描画しない
		}
		return { type: 'FeatureCollection', features };
	});

	// バスのポップアップはクリック時のスナップショットではなく毎フレームの最新位置に追随させる
	// (便が運行を終えたり日付が変わったら自動的に閉じる)
	const selectedBus = $derived.by(() => {
		const sel = selected;
		if (!sel || sel.kind !== 'bus') return null;
		return (
			buses.features.find((f) => `${f.properties.feedId}|${f.properties.tripId}` === sel.key) ??
			null
		);
	});

	// 路線ポップアップの表示内容はカタログから引く(feature properties には key しか載せない)
	const selectedRoute = $derived.by(() => {
		const sel = selected;
		if (!sel || sel.kind !== 'route') return null;
		const info = routeByKey.get(sel.key);
		return info ? { lnglat: sel.lnglat, info } : null;
	});

	// 脈動アニメーション(波紋リング + 本体の呼吸)。両レイヤは同じ基準半径から広がる
	const BUS_RADIUS = 7;
	const busPulsePaint: CircleLayerSpecification['paint'] = $derived({
		'circle-radius': BUS_RADIUS + pulse * 13,
		'circle-color': ROUTE_COLOR_EXPR,
		'circle-opacity': 0.4 * (1 - pulse),
		'circle-stroke-width': 0,
	});
	const busCorePaint: CircleLayerSpecification['paint'] = $derived({
		'circle-radius': BUS_RADIUS + Math.sin(pulse * Math.PI * 2) * 1.2,
		'circle-color': ROUTE_COLOR_EXPR,
		'circle-opacity': 0.78,
		'circle-stroke-width': 2,
		'circle-stroke-color': '#ffffff',
		'circle-stroke-opacity': 0.85,
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

<div class="fixed inset-0 overflow-hidden">
	<MapLibre
		bind:map
		class="h-full w-full"
		style={BASE_STYLE}
		bounds={JAPAN_BOUNDS}
		fitBoundsOptions={{ padding: 30 }}
		attributionControl={false}
		{cursor}
		onclick={(ev) => {
			// フィーチャ外のクリックで選択解除。ポップアップ内蔵の closeOnClick は
			// レイヤクリック後に発火して新しい選択まで消してしまうため無効化し、ここで自前判定する
			const m = ev.target;
			if (!m.getLayer('routes-hit') || !m.getLayer('buses')) return;
			if (m.queryRenderedFeatures(ev.point, { layers: ['routes-hit', 'buses'] }).length === 0) {
				selected = null;
			}
		}}
	>
		<BasemapControl active={basemap} onSelect={setBasemap} />
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
			<!-- 運休路線(最下層。細い破線グレーで運行中ラインの視認を妨げない) -->
			<LineLayer
				filter={INACTIVE_ROUTE_FILTER}
				layout={{ 'line-cap': 'butt', 'line-join': 'round' }}
				paint={{
					'line-color': '#9aa8ae',
					'line-width': 1.5,
					'line-opacity': 0.5,
					'line-dasharray': [2, 2.5],
				}}
			/>
			<!-- 運行中の路線ライン(地図が透けるよう細め・やや透明) -->
			<LineLayer
				filter={activeRouteFilter}
				layout={{ 'line-cap': 'round', 'line-join': 'round' }}
				paint={{ 'line-color': ROUTE_COLOR_EXPR, 'line-width': 2, 'line-opacity': 0.6 }}
			/>
			<!-- クリック判定用の透明な太いライン(運行路線のみ) -->
			<LineLayer
				id="routes-hit"
				filter={activeRouteFilter}
				layout={{ 'line-cap': 'round', 'line-join': 'round' }}
				paint={{ 'line-color': '#000000', 'line-opacity': 0, 'line-width': 14 }}
				onclick={(ev) => {
					// バス・停留所が下にある場合はそちら(ポップアップ/時刻表)を優先し、路線ポップアップは出さない
					const above = ev.target.queryRenderedFeatures(ev.point, {
						layers: ['buses', 'stops-active', 'stops-inactive'],
					});
					if (above.length > 0) return;
					const f = ev.features?.[0];
					if (!f || !f.properties) return;
					selected = {
						kind: 'route',
						key: String(f.properties.key),
						lnglat: [ev.lngLat.lng, ev.lngLat.lat],
					};
				}}
				onmouseenter={() => (cursor = 'pointer')}
				onmouseleave={() => (cursor = '')}
			/>
		</GeoJSONSource>

		<GeoJSONSource data={stopFC}>
			<!-- 運休停留所(小さいグレー点。運行中の白抜き+リングと別シンボルで目立たせない) -->
			<CircleLayer
				id="stops-inactive"
				minzoom={STOP_MIN_ZOOM}
				filter={STOP_INACTIVE_FILTER}
				paint={{
					'circle-radius': STOP_INACTIVE_RADIUS,
					'circle-color': STOP_INACTIVE_COLOR,
					'circle-opacity': 0.55,
					'circle-stroke-width': 0,
				}}
				onclick={handleStopClick}
				onmouseenter={() => (cursor = 'pointer')}
				onmouseleave={() => (cursor = '')}
			/>
			<!-- 運行中停留所(白抜き + 路線色リング。ラインの視認を妨げない) -->
			<CircleLayer
				id="stops-active"
				minzoom={STOP_MIN_ZOOM}
				filter={STOP_ACTIVE_FILTER}
				paint={{
					'circle-radius': STOP_ACTIVE_RADIUS,
					'circle-color': '#ffffff',
					'circle-stroke-width': STOP_ACTIVE_STROKE,
					'circle-stroke-color': ROUTE_COLOR_EXPR,
					'circle-opacity': 0.8,
					'circle-stroke-opacity': 0.85,
				}}
				onclick={handleStopClick}
				onmouseenter={() => (cursor = 'pointer')}
				onmouseleave={() => (cursor = '')}
			/>
		</GeoJSONSource>

		<GeoJSONSource data={selectedStopFC}>
			<!-- 選択中バス停のハイライトリング(バスの下・停留所の上) -->
			<CircleLayer
				paint={{
					'circle-radius': 11,
					'circle-color': 'rgba(226,88,31,0.15)',
					'circle-stroke-width': 2.5,
					'circle-stroke-color': '#e2581f',
				}}
			/>
		</GeoJSONSource>

		<GeoJSONSource data={buses}>
			<CircleLayer paint={busPulsePaint} />
			<CircleLayer
				id="buses"
				paint={busCorePaint}
				onclick={(ev) => {
					const f = ev.features?.[0];
					if (f && f.geometry.type === 'Point') {
						selected = {
							kind: 'bus',
							key: `${String(f.properties.feedId)}|${String(f.properties.tripId)}`,
						};
					}
				}}
				onmouseenter={() => (cursor = 'pointer')}
				onmouseleave={() => (cursor = '')}
			/>
		</GeoJSONSource>

		{#if selectedBus}
			<!-- onclose は自分の種別が選択中のときだけ解除する(別フィーチャをクリックした直後に
			     旧ポップアップの close が新しい選択を消してしまうのを防ぐ) -->
			<Popup
				lnglat={selectedBus.geometry.coordinates}
				closeOnClick={false}
				onclose={() => {
					if (selected?.kind === 'bus') selected = null;
				}}
			>
				<div class="text-sm">
					<div class="font-bold text-mi-slate-900">{selectedBus.properties.routeName}</div>
					<div class="text-mi-slate-600">便: {selectedBus.properties.tripId}</div>
				</div>
			</Popup>
		{/if}

		{#if selectedRoute}
			<Popup
				lnglat={selectedRoute.lnglat}
				closeOnClick={false}
				onclose={() => {
					if (selected?.kind === 'route') selected = null;
				}}
			>
				<div class="text-sm">
					<div class="flex items-center gap-2 font-bold text-mi-slate-900">
						<span
							class="h-1 w-4 flex-none rounded-full"
							style="background-color: {selectedRoute.info.color}"
						></span>
						<span>{selectedRoute.info.name}</span>
					</div>
					<div class="mt-0.5 text-mi-slate-600">
						<!-- serviceLabel のフォールバック値「運行」はそのまま、それ以外は「◯◯運行」と表記 -->
						{selectedRoute.info.feedName}・{selectedRoute.info.serviceLabel === '運行'
							? '運行'
							: `${selectedRoute.info.serviceLabel}運行`}
					</div>
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
	{#if data && !showPicker && buses.features.length === 0}
		<div
			class="absolute top-4 left-1/2 z-10 -translate-x-1/2 rounded-[10px] bg-mi-teal-900/90 px-4 py-2 text-sm text-white shadow-lg"
		>
			この日時に運行中のバスはありません(日付がダイヤの有効期間外の可能性があります)
		</div>
	{/if}

	{#if showPicker}
		<PrefecturePicker {map} {counts} onSelect={selectPref} />
	{/if}

	{#if selectedPref !== null && index}
		<PrefectureHeader prefName={prefectureById(selectedPref)?.ja ?? ''} onChange={clearPref} />
	{/if}

	{#if prefLoading}
		<div
			class="absolute top-1/2 left-1/2 z-20 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2.5 rounded-xl border border-mi-slate-200 bg-white/95 px-4 py-3 text-sm text-mi-slate-600 shadow-[0_8px_22px_rgba(7,48,61,0.16)]"
		>
			<span
				class="h-4 w-4 animate-spin rounded-full border-[2.5px] border-mi-slate-200 border-t-mi-teal-600"
			></span>
			全国の路線データを読み込み中…
		</div>
	{/if}

	{#if data && !showPicker}
		<RouteLayers routes={activeRoutes} bind:hidden {dateLabel} />
		<Controls
			busCount={buses.features.length}
			feedInfos={index && selectedPref !== null
				? index.feeds.filter((f) => f.prefId === selectedPref)
				: (index?.feeds ?? [])}
			mapAttribution={BASEMAPS[basemap].attribution}
		/>
		<StopTimetable
			open={!!selectedStop}
			stopName={selectedStop?.name ?? ''}
			{dateLabel}
			{timeLabel}
			timetable={stopTimetable}
			onClose={() => (selectedStop = null)}
		/>
	{/if}
</div>
