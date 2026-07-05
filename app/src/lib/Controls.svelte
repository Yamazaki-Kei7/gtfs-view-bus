<script lang="ts">
	import { MAX_TIME_SEC, sim } from '$lib/sim.svelte';
	import type { FeedIndexEntry } from '$lib/data';

	let { busCount, feedInfos }: { busCount: number; feedInfos: FeedIndexEntry[] } = $props();

	const timeLabel = $derived(
		`${String(Math.floor(sim.timeSec / 3600)).padStart(2, '0')}:${String(
			Math.floor((sim.timeSec % 3600) / 60),
		).padStart(2, '0')}`,
	);
</script>

<div
	class="absolute bottom-4 left-1/2 z-10 w-[min(680px,92vw)] -translate-x-1/2 space-y-2 rounded-lg bg-white/90 p-4 shadow-lg"
>
	<div class="flex flex-wrap items-center gap-3">
		<input type="date" bind:value={sim.date} class="rounded border px-2 py-1" />
		<button
			class="rounded bg-rose-600 px-3 py-1 text-white"
			onclick={() => (sim.playing = !sim.playing)}
		>
			{sim.playing ? '⏸ 停止' : '▶ 再生'}
		</button>
		<select bind:value={sim.speed} class="rounded border px-2 py-1">
			<option value={10}>×10</option>
			<option value={60}>×60</option>
			<option value={300}>×300</option>
		</select>
		<span class="font-mono text-lg tabular-nums">{timeLabel}</span>
		<span class="ml-auto text-sm text-gray-600">運行中: {busCount}台</span>
	</div>
	<input
		type="range"
		min="0"
		max={MAX_TIME_SEC}
		step="60"
		bind:value={sim.timeSec}
		class="w-full"
	/>
	<div class="text-xs text-gray-500">
		データ: {#each feedInfos as f (f.id)}{f.name}({f.license ?? 'ライセンス不明'}{f.status ===
			'error'
				? '・更新失敗'
				: ''})
		{/each}
		— GTFSデータリポジトリ(gtfs-data.jp) / 地図: © OpenStreetMap contributors
	</div>
</div>
