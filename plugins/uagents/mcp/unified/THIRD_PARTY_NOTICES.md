# Third-party notices

The committed `dist/server.mjs` bundle contains runtime code from these pinned packages:

- `@modelcontextprotocol/server` 2.0.0 (package metadata: MIT; supplied license file documents the project's Apache-2.0/MIT transition)
- `@modelcontextprotocol/core` 2.0.0 (package metadata: MIT; same supplied transition notice)
- `zod` 4.5.4 (MIT)

`esbuild` 0.28.2 (MIT) is a build dependency and is not required by the installed bundle. Exact dependency resolution and registry integrity hashes are recorded in `package-lock.json`. License texts supplied by the installed packages are retained under `third-party-licenses/`.

The bundle was generated from `src/server.mjs` with whitespace minified, trailing horizontal whitespace normalized, and legal comments retained at end of file. Rebuild with `npm ci --ignore-scripts && npm run build`; review dependency provenance before publishing a rebuilt archive.
