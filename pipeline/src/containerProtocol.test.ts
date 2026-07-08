import { describe, expect, it } from 'vitest';
import {
	CONTAINER_PROCESS_TIMEOUT_MS,
	containerInstanceName,
	parseFeedStatusResponse,
} from './containerProtocol';

describe('containerProtocol', () => {
	it('jobIdとfeedIdからContainer instance名を安定生成する', () => {
		expect(containerInstanceName('20260708T010203Z-a1b2c3', 'odpt~A/B~feed 1')).toBe(
			'feed-20260708T010203Z-a1b2c3-odpt~A%2FB~feed%201',
		);
	});

	it('Queue consumerの15分制限より短いtimeoutを使う', () => {
		expect(CONTAINER_PROCESS_TIMEOUT_MS).toBe(14 * 60 * 1000);
	});

	it('Containerから返るFeedStatus JSONを検証して返す', () => {
		const status = parseFeedStatusResponse(
			JSON.stringify({
				id: 'feed-1',
				name: 'フィード1',
				orgName: '事業者',
				license: null,
				fromDate: '2026-04-01',
				toDate: '2027-03-31',
				source: 'gtfs-data.jp',
				prefId: 10,
				status: 'updated',
				shapeSourceCounts: { shapes: 1, route: 0, straight: 0 },
			}),
		);
		expect(status).toEqual({
			id: 'feed-1',
			name: 'フィード1',
			orgName: '事業者',
			license: null,
			fromDate: '2026-04-01',
			toDate: '2027-03-31',
			source: 'gtfs-data.jp',
			prefId: 10,
			status: 'updated',
			shapeSourceCounts: { shapes: 1, route: 0, straight: 0 },
		});
	});

	it('不正なstatus値はrejectする', () => {
		expect(() =>
			parseFeedStatusResponse(
				JSON.stringify({
					id: 'feed-1',
					name: 'フィード1',
					orgName: '事業者',
					license: null,
					fromDate: '',
					toDate: '',
					source: 'gtfs-data.jp',
					status: 'broken',
				}),
			),
		).toThrow('container status response malformed: status');
	});
});
