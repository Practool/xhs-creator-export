import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import archiver from 'archiver';

const root = await fsp.realpath(fileURLToPath(new URL('../', import.meta.url)));
const pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
const name = `${pkg.name}-${pkg.version}`;
if (!/^[a-z0-9][a-z0-9.-]*$/.test(name)) throw new Error('非法发布包名称');
const modules = ['adapter', 'browser', 'cli', 'config', 'download', 'errors', 'exporter', 'files', 'naming', 'parser', 'runner', 'store', 'types'];
const historyModules = ["command", "discovery", "export", "mapping", "normalization", "repository", "safety", "sync", "types"];
const tests = ['helpers.mjs', 'history-core.test.mjs', 'history-sync.test.mjs', 'history-export.test.mjs', 'history-cli.test.mjs', 'legacy-regression.test.mjs'];
const docs = ['history-data', 'metric-mapping', 'getting-started', 'cli-reference', 'configuration', 'output-files', 'troubleshooting', 'privacy', 'dependencies'];
const common = ['package.json', 'package-lock.json', 'README.md', 'LICENSE', 'config.example.yaml', ...docs.map(n => `docs/${n}.md`)];
// No globs or directory walks: generated leftovers and private local files stay out.
const runtime = [...common, ...modules.map(n => `dist/${n}.js`), ...historyModules.map(n => `dist/history/${n}.js`)];
const source = [...common, ...modules.map(n => `src/${n}.ts`), ...historyModules.map(n => `src/history/${n}.ts`), ...tests.map(n => `tests/${n}`), 'tsconfig.json', 'scripts/package-release.mjs',
  '.gitignore', '.node-version', '.nvmrc'];
const npmFiles = new Set(pkg.files);
const expectedNpmFiles = runtime.filter(n => !['package.json', 'package-lock.json'].includes(n));
if (npmFiles.size !== expectedNpmFiles.length || expectedNpmFiles.some(n => !npmFiles.has(n))) {
  throw new Error('package.json files 与运行包白名单不一致');
}
// Validate every input before opening either output. Symlinks cannot import files from other locations.
for (const relative of new Set([...runtime, ...source])) {
  const filename = path.join(root, relative);
  const stat = await fsp.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || await fsp.realpath(filename) !== filename) {
    throw new Error('发布输入必须是项目内的普通文件：' + relative);
  }
}
const outDir = path.join(root, 'release');
await fsp.mkdir(outDir, { recursive: true });
const outStat = await fsp.lstat(outDir);
if (!outStat.isDirectory() || outStat.isSymbolicLink()) throw new Error('发布目录不能是符号链接');

async function writeArchive(filename, files) {
  const destination = path.join(outDir, filename);
  const temporary = destination + '.' + randomUUID() + '.tmp';
  const output = fs.createWriteStream(temporary, { flags: 'wx' });
  const archive = archiver('zip', { zlib: { level: 9 } });
  const completed = new Promise((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', reject);
  });
  // Attach handlers before asynchronous I/O starts, including on failure paths.
  const settled = completed.then(() => ({ ok: true }), error => ({ ok: false, error }));
  archive.pipe(output);
  try {
    for (const relative of [...files].sort()) archive.file(path.join(root, relative), { name: `${name}/${relative}` });
    await archive.finalize();
    const result = await settled;
    if (!result.ok) throw result.error;
    await fsp.rename(temporary, destination);
    const checksum = createHash('sha256').update(await fsp.readFile(destination)).digest('hex');
    const checksumTmp = destination + '.sha256.' + randomUUID() + '.tmp';
    try {
      await fsp.writeFile(checksumTmp, `${checksum}  ${filename}\n`, { flag: 'wx' });
      await fsp.rename(checksumTmp, destination + '.sha256');
    } finally { await fsp.rm(checksumTmp, { force: true }); }
    console.log(destination);
  } finally {
    archive.abort(); output.destroy();
    await settled;
    await fsp.rm(temporary, { force: true });
  }
}
await writeArchive(`${name}.zip`, runtime);
await writeArchive(`${name}-source.zip`, source);
