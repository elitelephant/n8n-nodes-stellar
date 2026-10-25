import type { IExecuteFunctions, INode, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { nodeForErrors } from '../../shared/horizon';
import * as payment from './payment/Payment.resource';

// An operation of the node gets all the input items of the run at once, so it can keep what the
// items share, such as the sequence number of a source account.
type NodeOperation = (this: IExecuteFunctions, node: INode) => Promise<INodeExecutionData[]>;

const resources: Record<string, Record<string, { execute: NodeOperation }>> = {
	payment: payment.operations,
};

// Runs the chosen operation. Resource and operation can't come from an expression, so they are the
// same for every item.
export async function router(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
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
	return [await chosen.execute.call(this, node)];
}
