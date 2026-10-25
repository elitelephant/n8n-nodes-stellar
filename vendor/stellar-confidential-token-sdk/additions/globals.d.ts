// n8n-nodes-stellar: the copied SDK compiles with the package's tsconfig, which has no DOM
// library and gets its Node types from @types/node 18. Upstream compiles with the DOM library.
// These are the only two browser globals the SDK names. See VENDORED.md.
//
// The declarations are global, so they also hold for the package's nodes and credentials, and they
// say what Node 24 has. Node 24 provides the Web Crypto `crypto` global, which the SDK uses for
// random scalars and deploy salts. It has no `localStorage` unless started with
// --experimental-webstorage, so it is typed as possibly undefined: the SDK's browser store checks
// `typeof localStorage` before using it, and any other code has to check too.
declare const crypto: { getRandomValues<T extends ArrayBufferView>(array: T): T };
declare const localStorage:
	| {
			getItem(key: string): string | null;
			setItem(key: string, value: string): void;
	  }
	| undefined;
