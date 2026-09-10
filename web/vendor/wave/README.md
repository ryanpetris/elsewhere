# Wave.js rendering subset

This directory pins Wave.js 2.0.5, upstream revision
`03b29e841a9d0dbce5845bb6faf75b9b0088c49f`, under its MIT license.
The normal npm install uses this local package; Vite imports its ES module.

`animations.js` adapts the bottom-oriented `Lines` and `Wave` animations and their
Canvas paths from `src/animations/Lines.ts`, `src/animations/Wave.ts` and
`src/util/Shapes.ts` at that revision. Lines also supports radial coordinates.
Only the drawing subset is included. Audio ownership and scheduling belong to
Elsewhere's `visualiser.js`; no Wave constructor or speaker connection is used.

The adaptation accepts normalized frequency bands, bounds every sample, scales
amplitudes to the destination rectangle, and batches same-colour paths. The line
spectrum retains Wave's closed area polygon. Gradients come from the caller.
The caller supplies logarithmic bands and distinct left/right data for stereo.
There are no image loaders, global listeners or animation callbacks in this package.

Upstream source: https://github.com/foobar404/wave.js/tree/03b29e841a9d0dbce5845bb6faf75b9b0088c49f
Release: https://registry.npmjs.org/@foobar404%2fwave/2.0.5

The local package and LICENSE are included by `scripts/acknowledgements.py` through
the npm lockfile. Keep this directory and its provenance together when updating it.
