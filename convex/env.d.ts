// The default Convex runtime exposes deployment env vars as `process.env` but is not
// Node.js. Declare only that, instead of pulling in @types/node (which would let
// Node-only APIs typecheck in code that cannot run them).
declare const process: { readonly env: Readonly<Record<string, string | undefined>> };
