import { describe, expect, it } from 'vitest';
import { parseGtfsTime } from './time';

describe('parseGtfsTime', () => {
	it('HH:MM:SS を秒に変換する', () => {
		expect(parseGtfsTime('08:10:30')).toBe(8 * 3600 + 10 * 60 + 30);
	});

	it('24時超をそのまま扱う', () => {
		expect(parseGtfsTime('25:10:00')).toBe(25 * 3600 + 10 * 60);
	});

	it('先頭ゼロなし(8:05:00)を扱う', () => {
		expect(parseGtfsTime('8:05:00')).toBe(8 * 3600 + 5 * 60);
	});

	it('空文字や不正値は null', () => {
		expect(parseGtfsTime('')).toBeNull();
		expect(parseGtfsTime('abc')).toBeNull();
	});
});
