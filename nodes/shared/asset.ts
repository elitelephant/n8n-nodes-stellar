import { Asset, type Horizon } from '@stellar/stellar-sdk';

// Reads an asset as the Stellar Signer's policy writes it: XLM or native for lumens, as the Stellar
// SDK and CLI write it, or CODE:ISSUER for any other asset. The SDK decides which codes and issuers
// are valid. Undefined if the value is none of them.
export function toAsset(value: unknown): Asset | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	if (value.toUpperCase() === 'XLM' || value.toLowerCase() === 'native') {
		return Asset.native();
	}
	// Without an issuer, the SDK would take the code XLM as the native asset.
	const parts = value.split(':');
	if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
		return undefined;
	}
	try {
		return new Asset(parts[0], parts[1]);
	} catch {
		return undefined;
	}
}

// An asset as the policy writes it: XLM for lumens and CODE:ISSUER for any other. An issued asset
// whose code is XLM isn't the native one.
export function assetName(asset: Asset): string {
	return asset.isNative() ? 'XLM' : `${asset.getCode()}:${asset.getIssuer()}`;
}

// The asset of a balance line of an account in Horizon, written as the policy writes it, or
// undefined for a line that isn't an asset, such as liquidity pool shares.
export function assetOfBalance(line: Horizon.HorizonApi.BalanceLine): string | undefined {
	if (line.asset_type === 'native') {
		return 'XLM';
	}
	if (line.asset_type === 'credit_alphanum4' || line.asset_type === 'credit_alphanum12') {
		return `${line.asset_code}:${line.asset_issuer}`;
	}
	return undefined;
}
