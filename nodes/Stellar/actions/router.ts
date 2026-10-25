import type { IDataObject, IExecuteFunctions, INode, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { nodeForErrors } from '../../shared/horizon';
import * as payment from './payment/Payment.resource';

type ItemOperation = (
	this: IExecuteFunctions,
	node: INode,
	itemIndex: number,
) => Promise<IDataObject>;

const resources: Record<string, Record<string, { execute: ItemOperation }>> = {
	payment: payment.operations,
};

// Runs the chosen operation once per input item. Resource and operation can't come from an
// expression, so they are the same for every item.
export async function router(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	const items = this.getInputData();
	// The node that goes into every error: a copy with the Horizon URL hidden.
	const node = nodeForErrors(this.getNode());
	const resource = this.getNodeParameter('resource', 0) as string;
	const operation = this.getNodeParameter('operation', 0) as string;
	const chosen = resources[resource]?.[operation];
	if (chosen === undefined) {
		throw new NodeOperationError(
			node,
			`The operation '${operation}' of '${resource}' isn't supported`,
		);
	}

	const returnData: INodeExecutionData[] = [];
	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		try {
			const json = await chosen.execute.call(this, node, itemIndex);
			returnData.push({ json, pairedItem: itemIndex });
		} catch (error) {
			// A NodeOperationError comes back as the same error and keeps its own itemIndex.
			const nodeError = new NodeOperationError(node, error, { itemIndex });
			// One that n8n built has the node as n8n keeps it, so it gets the copy.
			Object.assign(nodeError, { node });
			if (!this.continueOnFail()) {
				throw nodeError;
			}
			returnData.push({ json: items[itemIndex].json, error: nodeError, pairedItem: itemIndex });
		}
	}
	return [returnData];
}
