import type { IExecuteFunctions, INode, INodeExecutionData, INodeProperties } from 'n8n-workflow';

import { fromStroops } from '../../../shared/amount';
import { withAccountLock } from '../../state/lock';
import { forEachItem, NETWORK_NAME, stateErrorOf } from '../common';
import { holderContext, requireRegistered, syncHolder, tokenInfo } from './holder';

// Get Balance has no fields of its own.
export const description: INodeProperties[] = [];

// Reads each item's balances from the saved state, after syncing it with the chain. The sync checks
// the openings against the chain's commitments, so the balances are the chain's. Nothing is sent.
export async function execute(this: IExecuteFunctions, node: INode): Promise<INodeExecutionData[]> {
	return await forEachItem(this, node, async (itemIndex) => {
		const holder = await holderContext(this, node, itemIndex);
		const { client, account, contracts, folder } = holder;

		try {
			return await withAccountLock(folder, contracts.token, account, async () => {
				await requireRegistered(holder);
				const info = await tokenInfo(client, contracts.token, node, itemIndex);
				const { state, syncWarning } = await syncHolder(holder);
				return {
					account,
					token: contracts.token,
					asset: info.asset,
					spendable: fromStroops(state.spendable.v),
					receiving: fromStroops(state.receiving.v),
					syncedLedger: state.syncedLedger,
					syncWarning,
					networkName: NETWORK_NAME,
				};
			});
		} catch (error) {
			throw stateErrorOf(node, error, itemIndex) ?? error;
		}
	});
}
