import { configWithoutCloudSupport } from '@n8n/node-cli/eslint';

// Not eligible for n8n Cloud: the Stellar SDK is a runtime dependency, so the rule that
// forbids runtime dependencies is turned off. Strict mode is off in package.json because
// this file differs from the template's.
export default [
	// The Confidential Token SDK is third-party code, copied with the few changes its VENDORED.md
	// lists. The rules for node code don't apply to it; the files the package adds there are linted.
	{ ignores: ['vendor/stellar-confidential-token-sdk/src/**'] },
	...configWithoutCloudSupport,
	{
		files: ['package.json'],
		rules: {
			'@n8n/community-nodes/no-runtime-dependencies': 'off',
		},
	},
];
