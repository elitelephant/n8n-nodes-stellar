import type { IDataObject, IExecuteFunctions, INode, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

// Runs an operation once per input item and returns one output item for each. With Continue On
// Fail, an item that fails comes out with its error and the next one runs. Without it, the error
// stops the run.
export async function forEachItem(
	context: IExecuteFunctions,
	node: INode,
	run: (itemIndex: number) => Promise<IDataObject>,
): Promise<INodeExecutionData[]> {
	const items = context.getInputData();
	const returnData: INodeExecutionData[] = [];
	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		try {
			returnData.push({ json: await run(itemIndex), pairedItem: itemIndex });
		} catch (error) {
			const nodeError = errorOfNode(node, error, itemIndex);
			if (!context.continueOnFail()) {
				throw nodeError;
			}
			returnData.push({ json: items[itemIndex].json, error: nodeError, pairedItem: itemIndex });
		}
	}
	return returnData;
}

// The error that an operation gives n8n: a NodeOperationError comes back as the same error and keeps
// its own itemIndex, and one that n8n built gets the copy of the node with the Horizon URL hidden.
export function errorOfNode(node: INode, error: unknown, itemIndex?: number): NodeOperationError {
	const nodeError = new NodeOperationError(node, error as Error, { itemIndex });
	Object.assign(nodeError, { node });
	return nodeError;
}
