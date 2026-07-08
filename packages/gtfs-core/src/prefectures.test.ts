import { describe, expect, it } from 'vitest';
import { PREFECTURES, REGIONS } from './prefectures';

describe('都道府県マスタ', () => {
	it('47件で id は 1〜47 の重複なし', () => {
		expect(PREFECTURES).toHaveLength(47);
		const ids = PREFECTURES.map((p) => p.id);
		expect(new Set(ids).size).toBe(47);
		expect(Math.min(...ids)).toBe(1);
		expect(Math.max(...ids)).toBe(47);
	});

	it('各県の region は REGIONS に含まれる', () => {
		for (const p of PREFECTURES) expect(REGIONS).toContain(p.region);
	});

	it('地方順に北海道→九州で並ぶ', () => {
		expect(REGIONS).toEqual(['北海道', '東北', '関東', '中部', '近畿', '中国', '四国', '九州']);
		expect(PREFECTURES[0]).toMatchObject({ id: 1, ja: '北海道' });
		expect(PREFECTURES[46]).toMatchObject({ id: 47, ja: '沖縄県' });
	});
});
