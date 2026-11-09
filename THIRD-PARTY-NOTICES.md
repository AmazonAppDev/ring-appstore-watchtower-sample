# Third-Party Notices

Watchtower is licensed under the [MIT No Attribution (MIT-0) License](./LICENSE). It uses the open-source packages below.
Each is distributed under its own license, which permits the use made here. This file is provided
for attribution; it is not legal advice.

License texts are available in each package's directory under `node_modules/<package>/` after
`npm install`, and from the links below.

## Runtime dependencies

| Package | License | Project |
|---|---|---|
| `@aws-sdk/client-dynamodb` | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3 |
| `@aws-sdk/client-ses` | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3 |
| `@aws-sdk/lib-dynamodb` | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3 |
| `@codegenie/serverless-express` | Apache-2.0 | https://github.com/CodeGenieApp/serverless-express |
| `dotenv` | BSD-2-Clause | https://github.com/motdotla/dotenv |
| `express` | MIT | https://github.com/expressjs/express |
| `aws-cdk-lib` | Apache-2.0 | https://github.com/aws/aws-cdk |
| `constructs` | Apache-2.0 | https://github.com/aws/constructs |

## Development dependencies

| Package | License | Project |
|---|---|---|
| `aws-cdk` | Apache-2.0 | https://github.com/aws/aws-cdk |
| `vite` | MIT | https://github.com/vitejs/vite |
| `typescript` | Apache-2.0 | https://github.com/microsoft/TypeScript |
| `ts-node` | MIT | https://github.com/TypeStrong/ts-node |
| `@types/node` | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| `concurrently` | MIT | https://github.com/open-cli-tools/concurrently |
| `esbuild` | MIT | https://github.com/evanw/esbuild |

`esbuild` bundles the Lambda during `npm run deploy` (via the CDK `NodejsFunction` construct).
`aws-cdk-lib` also bundles some third-party packages inside it, such as `minimatch` (BlueOak-1.0.0);
those are listed in its own notices.

To regenerate a full dependency license report (including transitive dependencies), run a tool such
as [`license-checker`](https://github.com/davglass/license-checker):

```bash
npx license-checker --summary
```
