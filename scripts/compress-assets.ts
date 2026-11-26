import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

const COMPRESSIBLE = /\.(?:js|css)$/;

/** Precompress built JS/CSS assets into sibling .br and .gz files for sirv. */
export async function compressAssets(rootDir: string): Promise<number> {
  const targets: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && COMPRESSIBLE.test(entry.name)) targets.push(full);
    }
  };
  await walk(rootDir);

  await Promise.all(
    targets.map(async (file) => {
      const raw = await readFile(file);
      if (raw.length === 0) return;
      const [br, gz] = await Promise.all([
        brotliAsync(raw, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
            [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
            [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
          },
        }),
        gzipAsync(raw, { level: constants.Z_BEST_COMPRESSION }),
      ]);
      const writes: Promise<void>[] = [];
      if (br.length < raw.length) writes.push(writeFile(`${file}.br`, br));
      if (gz.length < raw.length) writes.push(writeFile(`${file}.gz`, gz));
      await Promise.all(writes);
    }),
  );
  return targets.length;
}

if (import.meta.main) {
  const dir = process.argv[2] ?? "dist/public";
  await compressAssets(dir);
}
