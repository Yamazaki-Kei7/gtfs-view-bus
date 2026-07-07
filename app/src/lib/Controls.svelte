<script lang="ts">
	import { MAX_TIME_SEC, nowJst, sim } from '$lib/sim.svelte';
	import type { FeedIndexEntry } from '$lib/data';

	let {
		busCount,
		feedInfos,
		mapAttribution,
	}: { busCount: number; feedInfos: FeedIndexEntry[]; mapAttribution: string } = $props();

	const timeLabel = $derived(
		`${String(Math.floor(sim.timeSec / 3600)).padStart(2, '0')}:${String(
			Math.floor((sim.timeSec % 3600) / 60),
		).padStart(2, '0')}`,
	);

	// スライダー(0〜28時)の下に並べる目盛ラベル
	const TIME_TICKS = ['0時', '4時', '8時', '12時', '16時', '20時', '24時', '28時'];

	function goNow() {
		const n = nowJst();
		sim.date = n.date;
		sim.timeSec = n.timeSec;
	}

	const SOURCE_CREDITS: Record<string, string> = {
		'gtfs-data.jp': 'GTFSデータリポジトリ(gtfs-data.jp)',
		odpt: '公共交通オープンデータセンター(ODPT)',
	};
	// source未設定の旧feeds.jsonはgtfs-data.jp由来として扱う
	const credits = $derived(
		[...new Set(feedInfos.map((f) => f.source ?? 'gtfs-data.jp'))]
			.map((s) => SOURCE_CREDITS[s] ?? s)
			.join(' / '),
	);

	// データ出典は既定で畳む(地図領域を優先。ⓘボタンで開閉)
	let attribOpen = $state(false);
</script>

<div
	class="absolute bottom-4 left-1/2 z-10 flex w-[min(680px,calc(100%-24px))] -translate-x-1/2 flex-col gap-2.5 rounded-2xl border border-mi-slate-200 bg-white/95 p-3.5 shadow-[0_10px_24px_rgba(7,48,61,0.14),0_2px_6px_rgba(7,48,61,0.08)] backdrop-blur sm:px-5 sm:py-4"
>
	<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
		<button
			onclick={goNow}
			title="現在日時に合わせる"
			class="flex items-center gap-1.5 rounded-[10px] border border-mi-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-mi-teal-600 transition-colors hover:bg-mi-teal-50"
		>
			<svg
				width="15"
				height="15"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				><circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15.5 14"
				></polyline></svg
			>
			<span>現在</span>
		</button>
		<input
			type="date"
			bind:value={sim.date}
			class="rounded-[10px] border border-mi-slate-300 bg-white px-2.5 py-1.5 text-sm text-mi-slate-900 focus:border-mi-teal-400 focus:ring-2 focus:ring-mi-teal-400/35 focus:outline-none"
		/>
		<button
			class="rounded-[10px] bg-mi-teal-600 px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-mi-teal-700"
			onclick={() => (sim.playing = !sim.playing)}
		>
			{sim.playing ? '⏸ 停止' : '▶ 再生'}
		</button>
		<select
			bind:value={sim.speed}
			class="rounded-[10px] border border-mi-slate-300 bg-white px-2.5 py-1.5 text-sm text-mi-slate-900 focus:border-mi-teal-400 focus:ring-2 focus:ring-mi-teal-400/35 focus:outline-none"
		>
			<option value={10}>×10</option>
			<option value={60}>×60</option>
			<option value={300}>×300</option>
		</select>
		<span class="font-mono text-lg leading-7 font-semibold text-mi-teal-600 tabular-nums"
			>{timeLabel}</span
		>
		<span class="ml-auto text-sm text-mi-slate-600"
			>運行中: <span class="font-bold text-mi-ember-500">{busCount}</span>台</span
		>
	</div>
	<div class="flex flex-col gap-0.5">
		<input
			type="range"
			min="0"
			max={MAX_TIME_SEC}
			step="60"
			bind:value={sim.timeSec}
			class="m-0 w-full accent-mi-teal-600"
		/>
		<div class="flex justify-between px-[7px]">
			{#each TIME_TICKS as tick (tick)}
				<div class="flex w-0 flex-col items-center gap-px">
					<span class="h-1 w-px bg-mi-slate-300"></span>
					<span class="font-mono text-[10px] leading-3 text-mi-slate-500 tabular-nums">{tick}</span>
				</div>
			{/each}
		</div>
	</div>
	<div class="flex flex-col">
		<button
			onclick={() => (attribOpen = !attribOpen)}
			title="データの出典"
			class="flex items-center gap-1.5 self-start py-0.5 text-[11px] leading-4 font-semibold text-mi-slate-500 transition-colors hover:text-mi-teal-600"
		>
			<svg
				width="13"
				height="13"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line
					x1="12"
					y1="8"
					x2="12.01"
					y2="8"
				></line></svg
			>
			<span>データの出典</span>
			<svg
				width="13"
				height="13"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2.2"
				stroke-linecap="round"
				stroke-linejoin="round"
				class="transition-transform {attribOpen ? 'rotate-180' : ''}"
				><polyline points="6 9 12 15 18 9"></polyline></svg
			>
		</button>
		{#if attribOpen}
			<div class="pt-1 text-xs leading-relaxed text-mi-slate-500">
				データ: {#each feedInfos as f (f.id)}{f.name}({f.license ?? 'ライセンス不明'}{f.status ===
					'error'
						? '・更新失敗'
						: ''})
				{/each}
				— {credits} / 地図: {mapAttribution} | MapLibre
			</div>
		{/if}
	</div>
</div>
