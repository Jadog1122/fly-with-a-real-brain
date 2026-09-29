// Bundle the game server for Node: server/main.ts and its brain thread, with the
// simulation modules from src/pet compiled in. esbuild is what vite already ships.
//
//   node server/build.mjs          -> server/dist/{main,brain-thread}.mjs

import { build } from 'esbuild'

await build({
  entryPoints: ['server/main.ts', 'server/brain-thread.ts'],
  outdir: 'server/dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // the one runtime dependency, resolved from node_modules at run time
  external: ['ws'],
  sourcemap: true,
  logLevel: 'info',
})
