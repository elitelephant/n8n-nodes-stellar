import type { INode } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { Keypair } from '@stellar/stellar-sdk';

import {
	deriveKeys,
	deriveSk,
	skSigningPayload,
	type KeyPair,
} from '../../vendor/stellar-confidential-token-sdk/src';
import { deriveStateKey } from './state/encryptedStore';

export interface HolderKeys {
	keypair: Keypair;
	// The G address of the account, which is the one that registers.
	account: string;
	// The confidential keys of the account in this token.
	keys: KeyPair;
	// The key of the account's state file.
	stateKey: Uint8Array;
}

// The keys of an account in a token, from the credential's Stellar secret key. The root of the
// derivation is the key's signature of the SEP-53 payload for this token and account, as OpenZeppelin
// v0.8.0 sdk-spec/key-derivation.md asks of a client that signs with a key: sign it twice to find a
// signer that isn't deterministic, and verify it against the key. The root is not kept: it is
// calculated on every run, and only the keys derived from it come out of here (ADR 0102, rule 3).
export function holderKeys(
	node: INode,
	secretKey: string,
	token: string,
	itemIndex: number,
): HolderKeys {
	let keypair: Keypair;
	try {
		keypair = Keypair.fromSecret(secretKey);
	} catch {
		// The SDK's own error can repeat what was read, so it isn't kept as the cause.
		throw new NodeOperationError(node, "'Secret Key' of the credential isn't valid", {
			itemIndex,
			description:
				'Enter the secret key of a Stellar account in the credential: 56 characters starting with S.',
		});
	}
	const account = keypair.publicKey();
	const payload = skSigningPayload(token, account);
	const root = keypair.sign(Buffer.from(payload));
	const again = keypair.sign(Buffer.from(payload));
	if (
		!Buffer.from(root).equals(Buffer.from(again)) ||
		!keypair.verify(Buffer.from(payload), Buffer.from(root))
	) {
		throw new NodeOperationError(node, "Couldn't derive the confidential keys of the account", {
			itemIndex,
			description:
				"The key's signature changed between two signatures of the same message, or didn't verify. The confidential keys come from that signature, so the node can't use them.",
		});
	}
	const rootBytes = new Uint8Array(root);
	const derived = deriveSk(rootBytes, token, account);
	const keys = deriveKeys(derived.sk, derived.addrF);
	return { keypair, account, keys, stateKey: deriveStateKey(rootBytes) };
}
