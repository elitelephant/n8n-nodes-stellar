# Programmatic nodes

Programmatic-style nodes implement an `execute` method and have full control over HTTP calls, loops,
transformations, etc.

Also read `.agents/nodes.md` for shared node anatomy and conventions.

## When to use

- You need multiple dependent API calls per node execution.
- You need complex transformations or branching logic.
- The API doesn't map cleanly into simple "one request per item" patterns.

The nodes in this package are programmatic-style: they use the Stellar SDK to build, sign and read
transactions, which a declarative node can't do.

## Canonical execute pattern

```typescript
async execute(
  this: IExecuteFunctions,
): Promise<INodeExecutionData[][]> {
  const items = this.getInputData();
  const returnData: INodeExecutionData[] = [];

  for (let i = 0; i < items.length; i++) {
    try {
      const resource = this.getNodeParameter('resource', i) as string;
      const operation = this.getNodeParameter('operation', i) as string;

      // Implement logic based on resource + operation
      // Use the Stellar SDK here (see "Guidelines" below)
      const responseData = {};

      returnData.push({
        json: responseData,
        pairedItem: { item: i },
      });
    } catch (error) {
      if (this.continueOnFail()) {
        // Keep the input's data and attach the error to the item
        returnData.push({
          json: items[i].json,
          error: new NodeOperationError(this.getNode(), error as Error, { itemIndex: i }),
          pairedItem: { item: i },
        });
        continue;
      }

      // Implement a check to see what error we have
      const isApiError = true;
      // Use NodeApiError for API-related errors
      if (isApiError) {
        throw new NodeApiError(this.getNode(), error as Error, { itemIndex: i });
      }

      // Use NodeOperationError for configuration/validation errors
      throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
    }
  }

  return [returnData];
}
```

## Guidelines

- Always get input items via `this.getInputData()`
- Pass the correct item index as the second argument to `getNodeParameter`
- Handle errors using `NodeApiError` (for API failures) and `NodeOperationError` (for
  operational/validation errors)
- Support `continueOnFail()` to allow workflows to proceed when possible. The failed item keeps its
  input's data, plus its error and its `pairedItem`, as the Stellar Signer does
- The Stellar Signer doesn't call the network. When a node needs the Stellar network, use the SDK's
  Horizon client instead of `this.helpers.httpRequest`
- Programmatic-style nodes support both **light and full versioning**. See `.agents/versioning.md`
  for details.
