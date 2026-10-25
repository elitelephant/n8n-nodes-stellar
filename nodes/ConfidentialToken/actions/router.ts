import type { IExecuteFunctions, INode, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { nodeForErrors } from '../transport/rpc';
import * as holder from './holder/Holder.resource';

// An operation of the node gets all the input items of the run at once.
type NodeOperation = (this: IExecuteFunctions, node: INode) => Promise<INodeExecutionData[]>;

const resources: Record<string, Record<string, { execute: NodeOperation }>> = {
	holder: holder.operations,
};

// Runs the chosen operation. Resource and operation can't come from an expression, so they are the
// same for every item.
export async function router(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	// The node that goes into every error: a copy with the RPC URL hidden.
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
