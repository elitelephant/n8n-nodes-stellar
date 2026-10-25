import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import { commonProperties } from './actions/common';
import * as payment from './actions/payment/Payment.resource';
import { router } from './actions/router';

export class Stellar implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Stellar',
		name: 'stellar',
		icon: {
			light: 'file:../StellarSigner/stellarLogo.svg',
			dark: 'file:../StellarSigner/stellarLogo.dark.svg',
		},
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["operation"] + ": " + $parameter["resource"] }}',
		description: 'Read the Stellar network and build unsigned transactions for the Stellar Signer',
		defaults: {
			name: 'Stellar',
		},
		// It has no key and signs nothing: signing stays in the Stellar Signer, which isn't a tool.
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Payment',
						value: 'payment',
					},
				],
				default: 'payment',
			},
			payment.operation,
			...commonProperties,
			...payment.fields,
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		return await router.call(this);
	}
}
