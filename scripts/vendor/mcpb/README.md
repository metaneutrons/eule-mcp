# MCPB format schema

`manifest-v0.3.schema.json` is an unmodified copy of
`dist/mcpb-manifest-v0.3.schema.json` from the published
`@anthropic-ai/mcpb@2.1.2` package. It is licensed under MIT; the original
copyright and permission notice are retained in `LICENSE`.

- Upstream repository: https://github.com/modelcontextprotocol/mcpb
- Release: https://github.com/modelcontextprotocol/mcpb/tree/v2.1.2
- Release commit: `2a788100a60db19a6b1c018fb1cf84ae85de9537`
- Schema SHA-256: `3a0ac9d845711a1b9b17dfa5a52f8b60628239d6a86a9db417206a9efc78592d`
- Format contract: https://github.com/modelcontextprotocol/mcpb/blob/v2.1.2/MANIFEST.md

The default exclusion patterns in `scripts/lib/mcpb-archive.mjs` preserve the
upstream packer's exclusions (`dist/node/files.js`, same package/license).

Eule needs only ZIP packaging and manifest validation. The full CLI also pulls
in interactive editor and signature-verification dependencies, including
vulnerable `tmp` and `node-forge` versions. It is deliberately not installed.
No advisory is ignored and no signing implementation is replaced or vendored.
The existing release provenance and native-helper signing remain unchanged.

When changing the supported manifest version, obtain the corresponding schema
from an explicitly reviewed upstream release, preserve its license, record its
version/commit/hash here, and update the positive/negative archive tests. Do not
fetch a schema dynamically during a build.
