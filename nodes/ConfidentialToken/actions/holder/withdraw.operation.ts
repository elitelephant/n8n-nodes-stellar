import type { IExecuteFunctions, INode, INodeExecutionData, INodeProperties } from 'n8n-workflow';

import {
	buildWithdrawWitness,
	submitWithdraw,
} from '../../../../vendor/stellar-confidential-token-sdk/src';
import { fromStroops, toStroops } from '../../../shared/amount';
import { readAmount } from '../../../Stellar/actions/payment/payment';
import { withProver } from '../../prover';
import { withAccountLock } from '../../state/lock';
import { forEachItem, NETWORK_NAME } from '../common';
import { holderContext, ledgerOf, syncAfterSend } from './holder';
import { failureAfterMerge, prepareSpend, readHolderPolicy, type SpendProgress } from './spend';

const showFor = { show: { resource: ['holder'], operation: ['withdraw'] } };

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
			"How much of the token's public asset to move from the confidential balance back to the account's public balance, with up to 7 decimals. The amount is public on the chain.",
	},
];

// Moves each item's amount from the account's confidential balance to its own public balance. The
// destination is always the holder's account (D-0348), so the policy checks only the amount before
// the proof. The fee guard and the automatic merge work as in Transfer.
export async function execute(this: IExecuteFunctions, node: INode): Promise<INodeExecutionData[]> {
	return await forEachItem(this, node, async (itemIndex) => {
		const stroops = toStroops(
			readAmount(
				node,
				this.getNodeParameter('amount', itemIndex),
				itemIndex,
				'Enter how much of the token to withdraw, for example 25 or 25.5.',
			),
		);
		const holder = await holderContext(this, node, itemIndex);
		const { client, account, contracts, folder, threads, keys } = holder;
		const policy = readHolderPolicy(holder);
		const progress: SpendProgress = { mergeTxHash: null };

		try {
			return await withAccountLock(folder, contracts.token, account, async () => {
				const plan = await prepareSpend(
					holder,
					policy,
					{ operation: 'withdraw', stroops },
					progress,
				);
				const witness = buildWithdrawWitness({
					keys,
					v: plan.spendable.v,
					r: plan.spendable.r,
					amount: stroops,
					kAudS: plan.senderAuditorKey,
				});
				const { proof } = await withProver(folder, threads, 'withdraw', (prover) =>
					prover.prove(witness.inputs),
				);
				const sent = await submitWithdraw(
					client,
					plan.signer,
					account,
					account,
					stroops,
					witness,
					proof,
				);
				const ledger = await ledgerOf(client, sent);
				const synced = await syncAfterSend(holder);
				return {
					account,
					token: contracts.token,
					asset: plan.info.asset,
					amount: fromStroops(stroops),
					txHash: sent.hash,
					ledger,
					mergedFirst: plan.mergedFirst,
					mergeTxHash: plan.mergeTxHash,
					syncedLedger: synced.syncedLedger,
					syncWarning: synced.syncWarning,
					networkName: NETWORK_NAME,
				};
			});
		} catch (error) {
			throw failureAfterMerge(holder, error, progress);
		}
	});
}
