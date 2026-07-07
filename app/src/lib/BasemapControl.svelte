<script lang="ts">
	import { CustomControl } from 'svelte-maplibre-gl';
	import { BASEMAP_KEYS, BASEMAPS, type BasemapKey } from '$lib/basemaps';

	let { active, onSelect }: { active: BasemapKey; onSelect: (key: BasemapKey) => void } =
		$props();
</script>

<CustomControl position="top-right" group={false}>
	<div
		class="flex flex-col overflow-hidden rounded-[10px] border border-mi-slate-200 bg-white/95 shadow-[0_4px_12px_rgba(7,48,61,0.14)] backdrop-blur"
	>
		{#each BASEMAP_KEYS as key, i (key)}
			<button
				type="button"
				title={BASEMAPS[key].label}
				onclick={() => onSelect(key)}
				class="px-2.5 py-1.5 text-[11px] font-bold tracking-wide whitespace-nowrap transition-colors {i >
				0
					? 'border-t border-mi-slate-200'
					: ''} {active === key
					? 'bg-mi-teal-600 text-white'
					: 'text-mi-slate-600 hover:bg-mi-slate-100'}"
			>
				{BASEMAPS[key].short}
			</button>
		{/each}
	</div>
</CustomControl>
