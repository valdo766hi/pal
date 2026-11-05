// Chord's optional esbuild peer serves only its experimental plugin builder, which Pal never imports. Without this,
// pnpm satisfies it from Pal's build-time esbuild and ships esbuild's native binary in the production package.
module.exports = {
  hooks: {
    readPackage(manifest) {
      if (manifest.name === "@earendil-works/chord") {
        delete manifest.peerDependencies?.esbuild;
        delete manifest.peerDependenciesMeta?.esbuild;
      }
      return manifest;
    },
  },
};
