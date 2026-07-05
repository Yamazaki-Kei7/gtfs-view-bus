import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv';

describe('parseCsv', () => {
	it('ヘッダ行をキーにしたオブジェクト配列を返す', () => {
		const rows = parseCsv('stop_id,stop_name\nA,駅前\nB,中央\n');
		expect(rows).toEqual([
			{ stop_id: 'A', stop_name: '駅前' },
			{ stop_id: 'B', stop_name: '中央' },
		]);
	});

	it('ダブルクォート・カンマ・改行入りフィールドを扱える', () => {
		const rows = parseCsv('id,name\n1,"a,b"\n2,"say ""hi"""\n3,"line1\nline2"\n');
		expect(rows[0].name).toBe('a,b');
		expect(rows[1].name).toBe('say "hi"');
		expect(rows[2].name).toBe('line1\nline2');
	});

	it('BOM・CRLF・末尾改行なしを扱える', () => {
		const rows = parseCsv('﻿id,name\r\n1,x\r\n2,y');
		expect(rows).toEqual([
			{ id: '1', name: 'x' },
			{ id: '2', name: 'y' },
		]);
	});

	it('CRのみの改行を行区切りとして扱える', () => {
		const rows = parseCsv('a,b\r1,2\r3,4');
		expect(rows).toEqual([
			{ a: '1', b: '2' },
			{ a: '3', b: '4' },
		]);
	});

	it('クォート内のCRはフィールド内容として保持される', () => {
		const rows = parseCsv('a,b\n1,"x\ry"');
		expect(rows).toEqual([{ a: '1', b: 'x\ry' }]);
	});

	it('EOFで閉じられていないクォートは寛容に閉じる', () => {
		const rows = parseCsv('a,b\n1,"unterminated');
		expect(rows).toEqual([{ a: '1', b: 'unterminated' }]);
	});

	it('欠けた列は空文字になる', () => {
		const rows = parseCsv('a,b,c\n1,2\n');
		expect(rows[0]).toEqual({ a: '1', b: '2', c: '' });
	});

	it('空文字列は空配列を返す', () => {
		expect(parseCsv('')).toEqual([]);
	});
});
