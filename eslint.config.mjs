import { configWithoutCloudSupport } from '@n8n/node-cli/eslint';

// Not eligible for n8n Cloud: the Stellar SDK is a runtime dependency, so the rule that
// forbids runtime dependencies is turned off. Strict mode is off in package.json because
// this file differs from the template's.
export default [
	...configWithoutCloudSupport,
	{
		files: ['package.json'],
		rules: {
			'@n8n/community-nodes/no-runtime-dependencies': 'off',
		},
	},
];
