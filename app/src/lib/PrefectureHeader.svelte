<script lang="ts">
	let { prefName, onChange }: { prefName: string; onChange: () => void } = $props();
</script>

<div
	class="absolute top-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2.5 rounded-xl border border-mi-slate-200 bg-white/95 py-1.5 pr-1.5 pl-3.5 shadow-[0_8px_20px_rgba(7,48,61,0.14)] backdrop-blur"
>
	<div class="flex min-w-0 flex-col">
		<span class="font-display text-[9.5px] leading-3 font-bold tracking-[0.08em] text-mi-slate-400"
			>PREFECTURE</span
		>
		<span class="truncate text-[15px] leading-5 font-bold text-mi-slate-900">{prefName}</span>
	</div>
	<button
		onclick={onChange}
		class="flex flex-none items-center gap-1.5 rounded-[9px] border border-mi-slate-300 bg-white px-2.5 py-1.5 text-[12.5px] font-bold text-mi-teal-600 transition-colors hover:bg-mi-teal-50"
	>
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"
			></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"
			></path></svg
		>
		変更
	</button>
</div>
