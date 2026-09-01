# Third-party notices

The committed `dist/gateway.cjs` and `dist/web-console/` files are generated from `@luckycat133/traecnclaw` 0.6.0 (MIT), downloaded from the exact npm tarball recorded in `UPSTREAM.json` and patched only as listed there. The tarball is retained under `vendor/` for reproducible review and its SHA-512 integrity is checked before every build.

The gateway bundle also contains `ws` 8.21.1 (MIT). The committed `dist/server.mjs` bundle contains runtime code from `@modelcontextprotocol/server` 2.0.0 and zod 4.5.4. esbuild 0.28.2 is used only for builds. Exact dependency resolution is recorded in `package-lock.json`; supplied license texts are retained under `third-party-licenses/`.

The Windows changes do not read authentication files or call TRAE private model APIs. They repair local durable writes, replace text in the Lexical composer, make the configured CDP port exclusive so a different Electron application cannot be selected by fallback scanning, and disable automatic continuation, dialog approval, and background retries for the bundled task route.
