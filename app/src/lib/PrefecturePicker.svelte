<script lang="ts">
	import type {
		Map as MaplibreMap,
		MapLayerMouseEvent,
		GeoJSONSourceSpecification,
	} from 'maplibre-gl';
	import { prefectureById } from 'gtfs-core';

	// `@types/geojson` は app の直接依存でないため bare import 'geojson' が解決できない。
	// maplibre-gl が再エクスポートする GeoJSON ソースの data 型(= GeoJSON.GeoJSON)を流用する。
	type GeoJSONData = GeoJSONSourceSpecification['data'];

	let {
		map,
		counts,
		onSelect,
	}: {
		map: MaplibreMap | undefined;
		/** 都道府県別フィード数(prefId → 件数) */
		counts: Map<number, number>;
		onSelect: (prefId: number) => void;
	} = $props();

	const REG = '#cfe6ee';
	const NONE = '#e7edf0';
	const HOVER = '#3a93b3';
	const SRC = 'pref-choropleth';
	// 参照デザインと同じ日本全体の表示範囲(ピッカー表示時に fitBounds する)
	const JAPAN_BBOX: [[number, number], [number, number]] = [
		[126, 26],
		[146, 46],
	];
	const registeredIds = $derived([...counts.keys()].filter((id) => (counts.get(id) ?? 0) > 0));
	const registeredCount = $derived(registeredIds.length);

	let toast = $state<string | null>(null);
	let tip = $state<{ x: number; y: number; text: string } | null>(null);
	let hoverId: number | null = null;
	let toastTimer: ReturnType<typeof setTimeout> | undefined;
	// ピッカー表示ごとに1回だけ日本全体へ寄せる(counts変化でeffectが再実行されても再フィットしない)
	let fitted = false;

	function showToast(msg: string) {
		toast = msg;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = null), 2600);
	}

	function setHover(id: number | null) {
		if (!map) return;
		if (hoverId !== null) map.setFeatureState({ source: SRC, id: hoverId }, { hover: false });
		hoverId = id;
		if (id !== null) map.setFeatureState({ source: SRC, id }, { hover: true });
	}

	function onMove(ev: MapLayerMouseEvent) {
		const f = ev.features?.[0];
		if (!f || typeof f.id !== 'number' || !map) return;
		if (f.id !== hoverId) setHover(f.id);
		const info = prefectureById(f.id);
		const n = counts.get(f.id) ?? 0;
		tip = {
			x: ev.point.x,
			y: ev.point.y,
			text: info ? `${info.ja}・${n > 0 ? `${n}フィード` : 'データなし'}` : '',
		};
		map.getCanvas().style.cursor = n > 0 ? 'pointer' : 'default';
	}

	function onLeave() {
		setHover(null);
		tip = null;
		if (map) map.getCanvas().style.cursor = '';
	}

	function onClick(ev: MapLayerMouseEvent) {
		const f = ev.features?.[0];
		if (!f || typeof f.id !== 'number') return;
		const n = counts.get(f.id) ?? 0;
		const info = prefectureById(f.id);
		if (n > 0) onSelect(f.id);
		else if (info) showToast(`${info.ja} はGTFSデータが未登録です`);
	}

	// map と counts が揃ったらコロプレスを追加。style 未ロードなら load を待つ。破棄時に一掃する。
	$effect(() => {
		const m = map;
		if (!m) return;
		const ids = registeredIds;
		let disposed = false;

		// 参照デザインどおり日本全体を表示する(初回マウント・「変更」での再表示とも)
		if (!fitted) {
			fitted = true;
			m.fitBounds(JAPAN_BBOX, { padding: 30, duration: 900 });
		}

		const add = (geo: GeoJSONData) => {
			if (disposed || m.getSource(SRC)) return;
			m.addSource(SRC, { type: 'geojson', data: geo, promoteId: 'id' });
			const before = m.getStyle().layers.find((l) => l.id !== 'base')?.id;
			m.addLayer(
				{
					id: 'pref-fill',
					type: 'fill',
					source: SRC,
					paint: {
						'fill-color': [
							'case',
							['boolean', ['feature-state', 'hover'], false],
							HOVER,
							['in', ['get', 'id'], ['literal', ids]],
							REG,
							NONE,
						],
						'fill-opacity': [
							'case',
							['boolean', ['feature-state', 'hover'], false],
							0.72,
							['in', ['get', 'id'], ['literal', ids]],
							0.5,
							0.4,
						],
					},
				},
				before,
			);
			m.addLayer(
				{
					id: 'pref-line',
					type: 'line',
					source: SRC,
					paint: { 'line-color': HOVER, 'line-width': 0.8, 'line-opacity': 0.7 },
				},
				before,
			);
			m.on('mousemove', 'pref-fill', onMove);
			m.on('mouseleave', 'pref-fill', onLeave);
			m.on('click', 'pref-fill', onClick);
		};

		fetch('/japan-prefectures.geojson')
			.then((r) => r.json() as Promise<GeoJSONData>)
			.then((geo) => {
				if (disposed) return;
				if (m.isStyleLoaded()) add(geo);
				else m.once('load', () => add(geo));
			})
			.catch(() => {});

		return () => {
			disposed = true;
			m.off('mousemove', 'pref-fill', onMove);
			m.off('mouseleave', 'pref-fill', onLeave);
			m.off('click', 'pref-fill', onClick);
			if (m.getLayer('pref-fill')) m.removeLayer('pref-fill');
			if (m.getLayer('pref-line')) m.removeLayer('pref-line');
			if (m.getSource(SRC)) m.removeSource(SRC);
			m.getCanvas().style.cursor = '';
			clearTimeout(toastTimer);
		};
	});
</script>

<!-- プロンプト -->
<div
	class="pointer-events-none absolute top-6 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-0.5 rounded-2xl border border-mi-slate-200 bg-white/95 px-6 py-3 text-center shadow-[0_10px_26px_rgba(7,48,61,0.14)] backdrop-blur"
>
	<div class="font-display text-[11px] font-bold tracking-[0.1em] text-mi-teal-600">
		SELECT PREFECTURE
	</div>
	<div class="text-[17px] leading-6 font-bold text-mi-slate-900">都道府県を選択してください</div>
	<div class="text-[12.5px] leading-[18px] text-mi-slate-500">
		地図をタップすると、その県のバス路線を表示します・<span class="font-bold text-mi-teal-600"
			>{registeredCount}</span
		> 都道府県が登録済み
	</div>
</div>

<!-- 凡例 -->
<div
	class="absolute bottom-6 left-4 z-10 flex flex-col gap-1.5 rounded-xl border border-mi-slate-200 bg-white/95 px-3.5 py-2.5 shadow-[0_6px_16px_rgba(7,48,61,0.12)] backdrop-blur"
>
	<div class="flex items-center gap-2 text-[11.5px] text-mi-slate-700">
		<span class="h-3 w-3 rounded-[3px] border-[1.5px] border-mi-teal-600" style="background:#cfe6ee"
		></span>データ登録あり
	</div>
	<div class="flex items-center gap-2 text-[11.5px] text-mi-slate-500">
		<span
			class="h-3 w-3 rounded-[3px] border-[1.5px] border-mi-slate-300"
			style="background:#e7edf0"
		></span>データなし
	</div>
</div>

<!-- ホバーツールチップ -->
{#if tip}
	<div
		class="pointer-events-none absolute z-30 rounded-[9px] bg-mi-teal-900/90 px-2.5 py-1.5 text-xs whitespace-nowrap text-white shadow-lg"
		style="left:{tip.x}px; top:{tip.y}px; transform:translate(14px,14px)"
	>
		{tip.text}
	</div>
{/if}

<!-- トースト -->
{#if toast}
	<div
		class="absolute bottom-6 left-1/2 z-30 -translate-x-1/2 rounded-[10px] bg-mi-teal-900/90 px-4 py-2.5 text-center text-[13.5px] text-white shadow-lg"
	>
		{toast}
	</div>
{/if}
