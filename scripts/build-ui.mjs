import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/ui/preview.ts"],
  bundle: true,
  outfile: "tizen/preview.js",
  format: "iife",
  target: "es2022",
  legalComments: "none",
});
