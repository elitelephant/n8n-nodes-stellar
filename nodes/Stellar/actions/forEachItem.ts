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
			// A NodeOperationError comes back as the same error and keeps its own itemIndex.
			const nodeError = new NodeOperationError(node, error, { itemIndex });
			// One that n8n built has the node as n8n keeps it, so it gets the copy.
			Object.assign(nodeError, { node });
			if (!context.continueOnFail()) {
				throw nodeError;
			}
			returnData.push({ json: items[itemIndex].json, error: nodeError, pairedItem: itemIndex });
		}
	}
	return returnData;
}
