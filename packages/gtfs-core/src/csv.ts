function parseCsvRows(text: string): string[][] {
	const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let inQuotes = false;
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (inQuotes) {
			if (ch === '"') {
				if (src[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				field += ch;
			}
		} else if (ch === '"') {
			inQuotes = true;
		} else if (ch === ',') {
			row.push(field);
			field = '';
		} else if (ch === '\n' || ch === '\r') {
			row.push(field);
			field = '';
			rows.push(row);
			row = [];
			if (ch === '\r' && src[i + 1] === '\n') {
				i++;
			}
		} else {
			field += ch;
		}
	}
	if (field !== '' || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

/**
 * Parse RFC4180-style CSV text into an array of objects keyed by the header row.
 *
 * Accepts LF, CRLF, and bare-CR line endings (a CR inside a quoted field stays
 * literal). Lenient rules: extra columns beyond the header are dropped; duplicate
 * header names — last one wins; missing columns become empty strings; an
 * unterminated quote is closed at EOF.
 */
export function parseCsv(text: string): Record<string, string>[] {
	const rows = parseCsvRows(text);
	if (rows.length === 0) return [];
	const header = rows[0].map((h) => h.trim());
	return rows.slice(1).map((r) => {
		const obj: Record<string, string> = {};
		header.forEach((h, i) => {
			obj[h] = r[i] ?? '';
		});
		return obj;
	});
}
