// Stellar amounts: a 64-bit integer of stroops, shown divided by ten million, so an amount has at
// most 7 digits after the decimal point and is at most (2^63 - 1) / 10^7.
const DECIMALS = 7;
const MAX_STROOPS = BigInt('9223372036854775807');
const DECIMAL_TEXT = /^(\d+)(?:\.(\d{1,7}))?$/;

// The amount as text, the way the Stellar SDK takes it, or undefined if it isn't a positive amount
// with up to 7 decimals. A number, as an expression can give, counts only if 7 decimals hold it
// exactly: rounding it would pay another amount.
export function toAmount(value: unknown): string | undefined {
	let text = value;
	if (typeof value === 'number') {
		if (!Number.isFinite(value) || Number(value.toFixed(DECIMALS)) !== value) {
			return undefined;
		}
		text = value.toFixed(DECIMALS);
	}
	if (typeof text !== 'string') {
		return undefined;
	}
	const parts = DECIMAL_TEXT.exec(text);
	if (parts === null) {
		return undefined;
	}
	const stroops =
		BigInt(parts[1]) * BigInt(10 ** DECIMALS) + BigInt((parts[2] ?? '').padEnd(DECIMALS, '0'));
	return stroops > BigInt(0) && stroops <= MAX_STROOPS ? text : undefined;
}
