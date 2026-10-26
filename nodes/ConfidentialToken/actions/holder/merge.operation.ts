import type { IExecuteFunctions, INode, INodeExecutionData, INodeProperties } from 'n8n-workflow';

import { keypairSigner, submitMerge } from '../../../../vendor/stellar-confidential-token-sdk/src';
import { NETWORK_PASSPHRASES } from '../../../shared/network';
import { withAccountLock } from '../../state/lock';
import { forEachItem, NETWORK_NAME, stateErrorOf } from '../common';
import { holderContext, ledgerOf, requireRegistered, syncAfterSend, tokenAsset } from './holder';

// Merge has no fields of its own.
export const description: INodeProperties[] = [];

// Moves each item's receiving balance into its spendable balance. A deposit or a transfer arrives
// in the receiving balance, and only the spendable one can be spent. The merge needs no proof.
export async function execute(this: IExecuteFunctions, node: INode): Promise<INodeExecutionData[]> {
	return await forEachItem(this, node, async (itemIndex) => {
		const holder = await holderContext(this, node, itemIndex);
		const { client, account, contracts, folder, secretKey } = holder;

		try {
			return await withAccountLock(folder, contracts.token, account, async () => {
				await requireRegistered(holder);
				// Read before the send, as Deposit does: a failure here sends nothing. Merge moves no
				// amount, so it reads only the asset, and one the node doesn't recognize is null.
				const asset = await tokenAsset(client, contracts.token, node, itemIndex);
				const sent = await submitMerge(
					client,
					keypairSigner(secretKey, NETWORK_PASSPHRASES.testnet),
					account,
				);
				const ledger = await ledgerOf(client, sent);
				const synced = await syncAfterSend(holder);
				return {
					account,
					token: contracts.token,
					asset,
					txHash: sent.hash,
					ledger,
					syncedLedger: synced.syncedLedger,
					syncWarning: synced.syncWarning,
					networkName: NETWORK_NAME,
				};
			});
		} catch (error) {
			throw stateErrorOf(node, error, itemIndex) ?? error;
		}
	});
}
