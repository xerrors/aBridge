# Third-party notices

The application uses the packages pinned in `package-lock.json`. Package names,
versions and bundled license files remain authoritative for the actual build.
The server distribution does not include the desktop SDK. Desktop installation
retains the official SDK packages and the license for its copied Node.js runtime.

| Component                                         | Use                                                       | License recorded by the installed package                               |
| ------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| Fastify and its official static/WebSocket plugins | HTTP and device connections                               | MIT                                                                     |
| Model Context Protocol TypeScript SDK v2          | MCP server and Node transport                             | Apache-2.0, with retained MIT transition notices in the package LICENSE |
| openid-client / oauth4webapi / jose               | OIDC login, token verification and JWKS                   | MIT                                                                     |
| Preact                                            | Bundled management console                                | MIT                                                                     |
| ws                                                | Device WebSocket connections                              | MIT                                                                     |
| Zod                                               | Runtime contract validation, including the browser bundle | MIT                                                                     |
| `@trycua/cua-driver` 0.47.8                       | Optional desktop-only official Node SDK                   | MIT                                                                     |
| Node.js                                           | Server runtime and copied desktop runtime                 | Node.js distribution LICENSE, including its third-party notices         |

Sources: [Fastify](https://github.com/fastify/fastify),
[MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk),
[Preact](https://github.com/preactjs/preact), [ws](https://github.com/websockets/ws),
[Zod](https://github.com/colinhacks/zod), [Cua](https://github.com/trycua/cua),
[Node.js](https://github.com/nodejs/node).

Installed npm dependencies retain their own LICENSE and NOTICE files. The
following original MIT notices are also included for code bundled into browser
assets and for the desktop SDK. The copied Node.js license is retained alongside
the private runtime as `Node-LICENSE`. aBridge itself is licensed under Apache-2.0; see the root LICENSE.

## Cua Driver

MIT License

Copyright (c) 2025 Cua AI, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Preact

The MIT License (MIT)

Copyright (c) 2015-present Jason Miller

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Zod

MIT License

Copyright (c) 2025 Colin McDonnell

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
