import { join } from 'node:path';

import {
	CircuitProver,
	setUltraHonkBackendLoader,
} from '../../vendor/stellar-confidential-token-sdk/src';
import {
	loadCircuit,
	type CircuitName,
} from '../../vendor/stellar-confidential-token-sdk/src/proving/artifacts';

// The points the CRS needs for the circuits of the token: 2^14 + 1, as the SDK's own tests prepare.
const CRS_POINTS = 16385;

// Runs `run` with a prover for one circuit. The CRS is prepared in `<folder>/crs` before the backend
// exists: bb.js downloads what is missing from crs.aztec.network, and without the CRS and without
// network access it rejects after 15 s and leaves its worker alive, which keeps n8n's process from
// ending. The prover is destroyed when `run` ends, whatever the result.
export async function withProver<T>(
	folder: string,
	threads: number,
	circuit: CircuitName,
	run: (prover: CircuitProver) => Promise<T>,
): Promise<T> {
	// bb.js is loaded here, as the SDK loads it, and not when n8n loads the node: it is large, and the
	// other nodes of the package don't need it.
	const { Crs, UltraHonkBackend } = await import('@aztec/bb.js');
	const crsPath = join(folder, 'crs');
	try {
		await Crs.new(CRS_POINTS, crsPath);
	} catch {
		// What bb.js throws can repeat the paths and the server, so it isn't kept as the cause. The
		// description travels on the error: n8n's NodeOperationError copies it from the error it wraps.
		// Source: tests/confidential-token/crs/LEEME.md (bb.js 0.87.0 downloads the CRS from
		// crs.aztec.network) and ADR 0106.
		throw Object.assign(new Error("Couldn't prepare the proving parameters"), {
			description:
				"The first proof downloads the CRS from crs.aztec.network into the 'crs' folder inside the state folder. Check that n8n can reach that server, or copy bn254_g1.dat and bn254_g2.dat there.",
		});
	}
	// The SDK creates its backend without options, which would use one thread and ~/.bb-crs.
	setUltraHonkBackendLoader(
		async () =>
			class extends UltraHonkBackend {
				constructor(bytecode: string) {
					super(bytecode, { threads, crsPath });
				}
			},
	);
	const prover = new CircuitProver(loadCircuit(circuit));
	try {
		return await run(prover);
	} finally {
		await prover.destroy();
	}
}
