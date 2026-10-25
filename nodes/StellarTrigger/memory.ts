import type { IPollFunctions } from 'n8n-workflow';

import type { NetworkName } from '../shared/network';

export type TriggerEvent = 'paymentReceived' | 'balanceBelowThreshold';

// What the Trigger keeps between polls, in its static data, for the event it watches. While the
// workflow is active, n8n keeps it in memory, and it saves it to the database when a poll returns
// items, right after activation and when the workflow is deactivated.
export interface TriggerMemory {
	event?: TriggerEvent;
	// Payment Received: the cursor of the last record it read, for which account and network. The
	// cursor is a Horizon paging token, or the one that means "from the account's first record".
	account?: string;
	networkName?: NetworkName;
	cursor?: string;
	// Balance Below Threshold: what it watches, and whether the balance was below the threshold at
	// the last poll, so it fires only when the balance goes below.
	lowBalance?: { watching: string; below: boolean };
}

// The Trigger's memory for the event. What another event left is cleared, so after the event
// changes back, Payment Received starts from now again instead of returning the payments received
// in between, and Balance Below Threshold fires again if the balance is below.
export function memoryFor(context: IPollFunctions, event: TriggerEvent): TriggerMemory {
	const memory = context.getWorkflowStaticData('node') as TriggerMemory;
	if (memory.event !== event) {
		for (const key of Object.keys(memory) as (keyof TriggerMemory)[]) {
			delete memory[key];
		}
		memory.event = event;
	}
	return memory;
}
