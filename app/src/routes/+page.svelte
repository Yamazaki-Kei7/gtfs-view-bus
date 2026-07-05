<script lang="ts">
	import {
		CircleLayer,
		GeoJSONSource,
		LineLayer,
		MapLibre,
		Popup,
		RasterLayer,
		RasterTileSource,
	} from 'svelte-maplibre-gl';
	import { busFeatureCollection, type BusFeatureCollection } from 'gtfs-core';
	import Controls from '$lib/Controls.svelte';
	import { loadAll, type LoadedData } from '$lib/data';
	import { MAX_TIME_SEC, sim } from '$lib/sim.svelte';

	let data = $state<LoadedData | null>(null);
	let loadError = $state<string | null>(null);
	let selected = $state<{ lnglat: [number, number]; routeName: string; tripId: string } | null>(
		null,
	);

	$effect(() => {
		loadAll()
			.then((d) => (data = d))
			.catch((e: Error) => (loadError = e.message));
	});

	const EMPTY_FC: BusFeatureCollection = { type: 'FeatureCollection', features: [] };
	const buses = $derived(
		data ? busFeatureCollection(data.feeds, sim.date.replaceAll('-', ''), sim.timeSec) : EMPTY_FC,
	);

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
		class="h-full w-full"
		style={{ version: 8, sources: {}, layers: [] }}
		center={[139.2, 36.35]}
		zoom={10}
	>
		<RasterTileSource
			tiles={['https://tile.openstreetmap.org/{z}/{x}/{y}.png']}
			tileSize={256}
			attribution="© OpenStreetMap contributors"
		>
			<RasterLayer />
		</RasterTileSource>
		{#if data}
			<GeoJSONSource data={data.routes}>
				<LineLayer paint={{ 'line-color': '#3b82f6', 'line-width': 2, 'line-opacity': 0.5 }} />
			</GeoJSONSource>
			<GeoJSONSource data={data.stops}>
				<CircleLayer
					paint={{
						'circle-radius': 3,
						'circle-color': '#6b7280',
						'circle-stroke-width': 1,
						'circle-stroke-color': '#ffffff',
					}}
				/>
			</GeoJSONSource>
		{/if}
		<GeoJSONSource data={buses}>
			<CircleLayer
				paint={{
					'circle-radius': 7,
					'circle-color': '#e11d48',
					'circle-stroke-width': 2,
					'circle-stroke-color': '#ffffff',
				}}
				onclick={(ev) => {
					const f = ev.features?.[0];
					if (f && f.geometry.type === 'Point') {
						selected = {
							lnglat: [f.geometry.coordinates[0], f.geometry.coordinates[1]],
							routeName: String(f.properties.routeName),
							tripId: String(f.properties.tripId),
						};
					}
				}}
			/>
		</GeoJSONSource>
		{#if selected}
			<Popup lnglat={selected.lnglat} onclose={() => (selected = null)}>
				<div class="text-sm">
					<div class="font-bold">{selected.routeName}</div>
					<div class="text-gray-600">便: {selected.tripId}</div>
				</div>
			</Popup>
		{/if}
	</MapLibre>

	{#if loadError}
		<div
			class="absolute top-4 left-1/2 z-10 -translate-x-1/2 rounded bg-red-600 px-4 py-2 text-white"
		>
			{loadError}
		</div>
	{/if}
	{#if data && buses.features.length === 0}
		<div
			class="absolute top-4 left-1/2 z-10 -translate-x-1/2 rounded bg-gray-800/80 px-4 py-2 text-sm text-white"
		>
			この日時に運行中のバスはありません(日付がダイヤの有効期間外の可能性があります)
		</div>
	{/if}
	<Controls busCount={buses.features.length} feedInfos={data?.index.feeds ?? []} />
</div>
