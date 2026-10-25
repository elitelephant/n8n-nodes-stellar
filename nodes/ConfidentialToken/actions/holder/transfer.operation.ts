import type { IExecuteFunctions, INode, INodeExecutionData, INodeProperties } from 'n8n-workflow';

import {
	buildTransferWitness,
	submitTransfer,
} from '../../../../vendor/stellar-confidential-token-sdk/src';
import { fromStroops, toStroops } from '../../../shared/amount';
import { readAmount } from '../../../Stellar/actions/payment/payment';
import { withProver } from '../../prover';
import { withAccountLock } from '../../state/lock';
import { forEachItem, NETWORK_NAME } from '../common';
import { holderContext, ledgerOf, syncAfterSend } from './holder';
import {
	failureAfterMerge,
	prepareSpend,
	readDestination,
	readHolderPolicy,
	type SpendProgress,
} from './spend';

const showFor = { show: { resource: ['holder'], operation: ['transfer'] } };

export const description: INodeProperties[] = [
	{
		displayName: 'Destination',
		name: 'destination',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. GABC...',
		displayOptions: showFor,
		description:
			'The account that receives the transfer, as a G address. It has to be registered in this token already.',
	},
	{
		displayName: 'Amount',
		name: 'amount',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. 25.5',
		displayOptions: showFor,
		description:
			"How much of the token's public asset to send, with up to 7 decimals. The amount stays hidden on the chain. It arrives in the destination's receiving balance.",
	},
];

// Sends each item's amount from the account's confidential balance to a registered account. The
// policy checks the plain amount and the destination before the proof, and the fee guard checks the
// total fee before each signature (D-0348). If the spendable balance is short but spendable plus
// received is not, the node merges first. The state is synced after the transfer.
export async function execute(this: IExecuteFunctions, node: INode): Promise<INodeExecutionData[]> {
	return await forEachItem(this, node, async (itemIndex) => {
		const destination = readDestination(
			node,
			this.getNodeParameter('destination', itemIndex),
			itemIndex,
		);
		const stroops = toStroops(
			readAmount(
				node,
				this.getNodeParameter('amount', itemIndex),
				itemIndex,
				'Enter how much of the token to transfer, for example 25 or 25.5.',
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
					{
						operation: 'transfer',
						stroops,
						destination,
					},
					progress,
				);
				// prepareSpend gives the recipient and both auditor keys for a transfer.
				const { recipient, recipientAuditorKey } = plan;
				if (recipient === undefined || recipientAuditorKey === undefined) {
					throw new Error('The transfer has no recipient');
				}
				const witness = buildTransferWitness({
					keys,
					v: plan.spendable.v,
					r: plan.spendable.r,
					amount: stroops,
					pvkB: recipient.viewingPublicKey,
					kAudR: recipientAuditorKey,
					kAudS: plan.senderAuditorKey,
				});
				const { proof } = await withProver(folder, threads, 'transfer', (prover) =>
					prover.prove(witness.inputs),
				);
				const sent = await submitTransfer(
					client,
					plan.signer,
					account,
					destination,
					witness,
					proof,
				);
				const ledger = await ledgerOf(client, sent);
				const synced = await syncAfterSend(holder);
				return {
					account,
					token: contracts.token,
					asset: plan.info.asset,
					destination,
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
