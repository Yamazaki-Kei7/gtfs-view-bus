import { describe, expect, it } from 'vitest';
import { createBusKyoSource } from './busKyo';

describe('createBusKyoSource', () => {
	it('マニフェストの17事業者をFeedTargetへ写像する', async () => {
		const targets = await createBusKyoSource().listTargets(fetch);
		expect(targets).toHaveLength(17);
	});

	it('先頭エントリ(広島電鉄)を規約どおりに写像する', async () => {
		const targets = await createBusKyoSource().listTargets(fetch);
		expect(targets[0]).toEqual({
			id: 'bus-kyo~hiroden',
			name: '広島電鉄',
			orgName: '広島電鉄',
			license: 'CC0',
			fromDate: '',
			toDate: '',
			source: 'bus-kyo',
			versionId: '',
			zipUrl: 'https://ajt-mobusta-gtfs.mcapps.jp/static/8/latest.zip',
			prefId: 34,
		});
	});

	it('全フィードが広島県(34)・CC0・source=bus-kyo・versionId空である', async () => {
		const targets = await createBusKyoSource().listTargets(fetch);
		for (const t of targets) {
			expect(t.prefId).toBe(34);
			expect(t.license).toBe('CC0');
			expect(t.source).toBe('bus-kyo');
			expect(t.versionId).toBe('');
			expect(t.id.startsWith('bus-kyo~')).toBe(true);
		}
	});

	it('idが一意である', async () => {
		const targets = await createBusKyoSource().listTargets(fetch);
		const ids = targets.map((t) => t.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
