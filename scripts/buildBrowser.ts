// Use TensorFlow's official browser distribution so backend/platform registrations
// survive bundling; the application code still imports the shared training engine.
await Bun.write("./public/generated/tf.min.js", Bun.file("./node_modules/@tensorflow/tfjs/dist/tf.min.js"));
for (const [entry, name] of [["browserWorker", "training-worker"], ["recommendationWorker", "recommendation-worker"]]) {
const result = await Bun.build({
  entrypoints: [`./src/training/${entry}.ts`],
  outdir: "./public/generated",
  naming: `${name}.js`,
  target: "browser",
  minify: true,
  plugins: [{
    name: "tensorflow-browser-runtime",
    setup(build) {
      build.onResolve({ filter: /^@tensorflow\/tfjs$/ }, () => ({ path: "tensorflow", namespace: "browser-runtime" }));
      build.onLoad({ filter: /.*/, namespace: "browser-runtime" }, () => ({
        loader: "js",
        contents: `importScripts("/generated/tf.min.js");
          export const {setBackend, ready, tidy, tensor2d, sequential, layers, initializers,
            train, io, loadLayersModel, memory, nextFrame} = self.tf;`,
      }));
    },
  }],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

}
