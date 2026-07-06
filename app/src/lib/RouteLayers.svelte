<script lang="ts">
	import { onMount } from 'svelte';
	import type { RouteInfo } from 'gtfs-core';

	let {
		routes,
		hidden,
		onToggle,
		dateLabel,
	}: {
		routes: RouteInfo[];
		hidden: Record<string, boolean>;
		onToggle: (key: string) => void;
		dateLabel: string;
	} = $props();

	// SSR では window が無いため既定は開いた状態。マウント後にモバイル幅なら畳む。
	let open = $state(true);
	onMount(() => {
		if (window.matchMedia('(max-width: 640px)').matches) open = false;
	});
</script>

{#if open}
	<div
		class="absolute top-4 left-4 z-10 flex w-[min(248px,calc(100%-32px))] flex-col overflow-hidden rounded-2xl border border-mi-slate-200 bg-white/95 shadow-[0_10px_24px_rgba(7,48,61,0.14),0_2px_6px_rgba(7,48,61,0.08)] backdrop-blur"
	>
		<div class="flex items-start gap-2 border-b border-mi-slate-200 py-2.5 pr-3 pl-4">
			<div class="flex min-w-0 flex-1 flex-col gap-0.5">
				<div
					class="font-display text-[11px] leading-4 font-bold tracking-[0.08em] text-mi-slate-500"
				>
					ROUTE LAYERS
				</div>
				<div class="text-sm leading-5 font-bold text-mi-slate-900">
					運行中の路線 <span class="font-semibold text-mi-teal-600">{dateLabel}</span>
				</div>
			</div>
			<button
				onclick={() => (open = false)}
				title="最小化"
				class="flex h-7 w-7 flex-none items-center justify-center rounded-lg text-mi-slate-500 transition-colors hover:bg-mi-slate-100 hover:text-mi-slate-700"
				aria-label="路線レイヤを最小化"
			>
				<svg
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg
				>
			</button>
		</div>
		<div class="flex max-h-[56vh] flex-col gap-0.5 overflow-auto px-2.5 pt-2 pb-3">
			{#if routes.length === 0}
				<div class="px-2 py-3 text-[13px] text-mi-slate-500">この日に運行する路線はありません</div>
			{/if}
			{#each routes as ly (ly.key)}
				<label
					class="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-mi-slate-50"
				>
					<input
						type="checkbox"
						checked={!hidden[ly.key]}
						onchange={() => onToggle(ly.key)}
						class="m-0 flex-none accent-mi-teal-600"
					/>
					<span class="h-1 w-5 flex-none rounded-full" style="background-color: {ly.color}"></span>
					<span class="flex min-w-0 flex-col">
						<span class="text-[13px] leading-tight font-semibold text-mi-slate-900">{ly.name}</span>
						<span class="text-[11px] leading-tight text-mi-slate-500"
							>{ly.feedName}・{ly.serviceLabel}運行</span
						>
					</span>
				</label>
			{/each}
		</div>
	</div>
{:else}
	<button
		onclick={() => (open = true)}
		title="路線レイヤを表示"
		class="absolute top-4 left-4 z-10 flex items-center gap-2 rounded-[10px] border border-mi-slate-200 bg-white/95 px-3.5 py-2 text-[13px] font-semibold text-mi-slate-900 shadow-[0_4px_12px_rgba(7,48,61,0.14)] backdrop-blur transition-colors hover:bg-mi-teal-50"
	>
		<svg
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="var(--color-mi-teal-600)"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"
			></polyline><polyline points="2 12 12 17 22 12"></polyline></svg
		>
		<span>路線レイヤ</span>
	</button>
{/if}
