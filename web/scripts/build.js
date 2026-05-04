import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const dist = join(root, 'dist');
const assets = join(dist, 'assets');

await rm(dist, { recursive: true, force: true });
await mkdir(assets, { recursive: true });

const result = await Bun.build({
  entrypoints: ['./src/main.js'],
  outdir: './dist/assets',
  target: 'browser',
  format: 'esm',
  minify: true,
  sourcemap: 'none',
  define: {
    __VUE_OPTIONS_API__: 'true',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

await copyFile(join(root, 'src', 'styles.css'), join(assets, 'styles.css'));
await writeFile(
  join(dist, 'index.html'),
  `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="referrer" content="no-referrer" />
    <title>Aikan Static HLS</title>
    <link rel="stylesheet" href="./assets/styles.css" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="./assets/main.js"></script>
  </body>
</html>
`,
);

console.log('Built static site to dist/');
