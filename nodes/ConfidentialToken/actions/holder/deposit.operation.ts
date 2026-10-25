import type { IExecuteFunctions, INode, INodeExecutionData, INodeProperties } from 'n8n-workflow';

import {
	keypairSigner,
	submitDeposit,
} from '../../../../vendor/stellar-confidential-token-sdk/src';
import { fromStroops, toStroops } from '../../../shared/amount';
import { NETWORK_PASSPHRASES } from '../../../shared/network';
import { readAmount } from '../../../Stellar/actions/payment/payment';
import { withAccountLock } from '../../state/lock';
import { forEachItem, NETWORK_NAME, stateErrorOf } from '../common';
import { holderContext, ledgerOf, requireRegistered, syncAfterSend, tokenInfo } from './holder';

const showFor = { show: { resource: ['holder'], operation: ['deposit'] } };

export const description: INodeProperties[] = [
	{
		displayName: 'Amount',
		name: 'amount',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. 25.5',
		displayOptions: showFor,
		description:
			"How much of the token's public asset to deposit, with up to 7 decimals. It arrives in the receiving balance.",
	},
];

// Deposits each item's amount from the account's public balance into its own confidential balance.
// There is no policy on it (D-0348): a deposit only moves the account's own funds, and the amount
// is public on the chain either way. The state is synced after the deposit, so the item shows the
// ledger it is synced to.
export async function execute(this: IExecuteFunctions, node: INode): Promise<INodeExecutionData[]> {
	return await forEachItem(this, node, async (itemIndex) => {
		const stroops = toStroops(
			readAmount(
				node,
				this.getNodeParameter('amount', itemIndex),
				itemIndex,
				'Enter how much of the token to deposit, for example 25 or 25.5.',
			),
		);
		const holder = await holderContext(this, node, itemIndex);
		const { client, account, contracts, folder, secretKey } = holder;

		try {
			return await withAccountLock(folder, contracts.token, account, async () => {
				await requireRegistered(holder);
				const info = await tokenInfo(client, contracts.token, node, itemIndex);
				const sent = await submitDeposit(
					client,
					keypairSigner(secretKey, NETWORK_PASSPHRASES.testnet),
					account,
					account,
					stroops,
				);
				const ledger = await ledgerOf(client, sent);
				const synced = await syncAfterSend(holder);
				return {
					account,
					token: contracts.token,
					asset: info.asset,
					amount: fromStroops(stroops),
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
