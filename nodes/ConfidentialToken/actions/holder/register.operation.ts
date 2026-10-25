import type { IExecuteFunctions, INode, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import {
	buildRegisterWitness,
	keypairSigner,
	pointToBytes,
	submitRegister,
} from '../../../../vendor/stellar-confidential-token-sdk/src';
import { NETWORK_PASSPHRASES } from '../../../shared/network';
import { withProver } from '../../prover';
import { withAccountLock } from '../../state/lock';
import { forEachItem, NETWORK_NAME, stateErrorOf } from '../common';
import { holderContext, ledgerOf, syncAfterSend, syncHolder, type SyncAfterSend } from './holder';

const showFor = { show: { resource: ['holder'], operation: ['register'] } };

export const description: INodeProperties[] = [
	{
		displayName: 'Auditor ID',
		name: 'auditorId',
		type: 'number',
		typeOptions: {
			minValue: 0,
			numberPrecision: 0,
		},
		default: 0,
		displayOptions: showFor,
		// Stellar, https://developers.stellar.org/meetings/2026/09/03 (Stellar Raven, 25-10-2026): "the
		// auditor is chosen per account at registration, out of a registry that can hold many keys".
		// OpenZeppelin compliance.md v0.8.0: "auditor_id is immutable once the account is registered".
		description:
			"The auditor that can read this account's amounts, by its ID in the token's auditor registry. It is chosen when the account registers and can't be changed later.",
	},
];

// Registers each item's account in the token, or finds it already registered with the same key
// (D-0351). The account is the credential's Stellar key, and the confidential keys come from that
// key's signature. The state of the account is synced from the ledger where the registration was
// sent, so the registration is in the events it reads.
export async function execute(this: IExecuteFunctions, node: INode): Promise<INodeExecutionData[]> {
	return await forEachItem(this, node, async (itemIndex) => {
		const auditorId = readAuditorId(this, node, itemIndex);
		const holder = await holderContext(this, node, itemIndex);
		const { client, account, keys, contracts, folder, threads, secretKey } = holder;

		try {
			return await withAccountLock(folder, contracts.token, account, async () => {
				const onChain = await client.confidentialBalance(account);

				if (onChain === null) {
					// The ledger is read before the registration is sent, so it is at or before the
					// registration's own event (OpenZeppelin, build-with-the-sdk.mdx: "fromLedger ...
					// must be at or before their first event").
					const fromLedger = await client.latestLedger();
					const witness = buildRegisterWitness(keys, account);
					const { proof } = await withProver(folder, threads, 'register', (prover) =>
						prover.prove(witness.inputs),
					);
					const sent = await submitRegister(
						client,
						keypairSigner(secretKey, NETWORK_PASSPHRASES.testnet),
						account,
						auditorId,
						witness,
						proof,
					);
					const ledger = await ledgerOf(client, sent);
					const synced = await syncAfterSend(holder, { fromLedger });
					return output(account, contracts.token, false, sent.hash, ledger, synced);
				}

				// The account is registered. If its key is the one this credential derives, there is
				// nothing to send: the state is synced and the item says so.
				if (!sameKey(pointToBytes(onChain.spendingKey), pointToBytes(keys.Y))) {
					// Text E; source: OpenZeppelin sdk-spec/key-derivation.md v0.8.0, "a client MUST
					// therefore read a Y mismatch under Signer roots as evidence that the account uses a
					// root it does not hold".
					throw new NodeOperationError(
						node,
						'This account is registered in this token with another key',
						{
							itemIndex,
							description:
								"The token keeps the key the account registered with, and the key this credential derives is different, so the node can't use this account. An account registers once per token, so this can't be changed: use the credential that registered it, or register another account.",
						},
					);
				}
				const { state, syncWarning } = await syncHolder(holder);
				return output(account, contracts.token, true, null, null, {
					syncedLedger: state.syncedLedger,
					syncWarning,
				});
			});
		} catch (error) {
			throw stateErrorOf(node, error, itemIndex) ?? error;
		}
	});
}

function readAuditorId(context: IExecuteFunctions, node: INode, itemIndex: number): number {
	const value = context.getNodeParameter('auditorId', itemIndex, 0);
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new NodeOperationError(node, "'Auditor ID' must be a whole number, 0 or more", {
			itemIndex,
			description: "Enter the auditor's ID in the token's auditor registry, for example 0.",
		});
	}
	return value;
}

function sameKey(a: Uint8Array, b: Uint8Array): boolean {
	return Buffer.from(a).equals(Buffer.from(b));
}

function output(
	account: string,
	token: string,
	alreadyRegistered: boolean,
	txHash: string | null,
	ledger: number | null,
	synced: SyncAfterSend,
) {
	return {
		account,
		token,
		registered: true,
		alreadyRegistered,
		txHash,
		ledger,
		syncedLedger: synced.syncedLedger,
		syncWarning: synced.syncWarning,
		networkName: NETWORK_NAME,
	};
}
