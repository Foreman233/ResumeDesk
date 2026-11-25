import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const noticeName = /^(?:licen[cs]e|copying|notice|copyright)(?:$|[-_. ])/i;
const entries = [];
const byText = new Map();

function noticeFiles(directory, prefix = '') {
  return readdirSync(join(directory, prefix), { withFileTypes: true })
    .filter((entry) => entry.isFile() && noticeName.test(entry.name))
    .map((entry) => ({ name: join(prefix, entry.name).replaceAll('\\', '/'), path: join(directory, prefix, entry.name) }))
    .sort((first, second) => first.name < second.name ? -1 : Number(first.name !== second.name));
}

function addEntry(ecosystem, pkg, source, files) {
  const references = files.flatMap((file) => {
    const text = readFileSync(file.path, 'utf8').replaceAll('\r\n', '\n').trimEnd();
    if (!text) return [];
    if (!byText.has(text)) byText.set(text, byText.size + 1);
    return [`${file.name} (N${byText.get(text)})`];
  });
  const license = typeof pkg.license === 'object' ? pkg.license?.type : pkg.license;
  entries.push([`${ecosystem} ${pkg.name} ${pkg.version}`, `License ${license ?? 'see package source'}`, `Source ${source}`,
    references.length ? `Notices ${references.join(', ')}` : 'See notices in the corresponding package source.'].join('\n'));
}

function packageDirectory(name, importer) {
  const paths = createRequire(join(importer, 'package.json')).resolve.paths(`${name}/package.json`) ?? [];
  for (const path of paths) {
    const manifest = join(path, name, 'package.json');
    if (existsSync(manifest)) return dirname(realpathSync(manifest));
  }
}

const recordedNpm = new Set();
function addNpm(name, importer, optional = false) {
  const directory = packageDirectory(name, importer);
  if (!directory) {
    if (optional) return;
    throw new Error(`Install locked npm dependency ${name} before generating notices.`);
  }
  const pkg = readJson(join(directory, 'package.json'));
  const id = `${pkg.name}@${pkg.version}`;
  if (recordedNpm.has(id)) return;
  recordedNpm.add(id);
  const files = noticeFiles(directory);
  if (pkg.name === 'pdfjs-dist') {
    for (const folder of ['cmaps', 'iccs', 'standard_fonts', 'wasm']) files.push(...noticeFiles(directory, folder));
  }
  addEntry('npm', pkg, `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`, files);
  for (const dependency of Object.keys(pkg.dependencies ?? {}).sort()) addNpm(dependency, directory);
  for (const dependency of Object.keys(pkg.optionalDependencies ?? {}).sort()) addNpm(dependency, directory, true);
}

const frontend = readJson(join(root, 'package.json'));
for (const name of [...Object.keys(frontend.dependencies), 'jszip', 'tailwindcss'].sort()) addNpm(name, root);

function cargoMetadata() {
  const supplied = process.argv.find((argument) => argument.startsWith('--metadata='));
  if (supplied) return readJson(supplied.slice('--metadata='.length));
  const cargo = spawnSync('cargo', ['metadata', '--locked', '--format-version', '1', '--filter-platform',
    'x86_64-pc-windows-msvc', '--features', 'custom-protocol', '--manifest-path', 'src-tauri/Cargo.toml'],
  { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (cargo.status !== 0) throw new Error(cargo.stderr || cargo.error?.message || 'Cargo metadata failed.');
  return JSON.parse(cargo.stdout);
}

const metadata = cargoMetadata();
const packageById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
const nodeById = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
const pending = [metadata.resolve.root];
const visited = new Set();
while (pending.length) {
  const id = pending.pop();
  if (visited.has(id)) continue;
  visited.add(id);
  for (const dependency of nodeById.get(id).deps) {
    if (dependency.dep_kinds.some((kind) => kind.kind === null)) pending.push(dependency.pkg);
  }
}
visited.delete(metadata.resolve.root);
const packages = [...visited].map((id) => packageById.get(id));
packages.sort((first, second) => `${first.name} ${first.version}`.localeCompare(`${second.name} ${second.version}`, 'en'));
for (const pkg of packages) {
  const directory = dirname(pkg.manifest_path);
  const files = noticeFiles(directory);
  if (pkg.license_file) {
    const path = resolve(directory, pkg.license_file);
    if (existsSync(path) && !files.some((file) => file.path === path)) files.push({ name: basename(path), path });
  }
  addEntry('crate', pkg, `https://static.crates.io/crates/${pkg.name}/${pkg.name}-${pkg.version}.crate`, files);
}

const notices = [...byText].map(([text, id]) => [`----- N${id} -----`, text].join('\n')).join('\n\n');
const output = ['ResumeDesk third-party notices',
  'This file covers the frontend assets and Cargo normal dependency graph for Windows x64. Source URLs identify the corresponding package versions.',
  entries.join('\n\n'), notices, ''].join('\n\n');
const file = join(root, 'THIRD_PARTY_NOTICES.txt');
if (process.argv.includes('--check')) {
  if (readFileSync(file, 'utf8').replaceAll('\r\n', '\n') !== output) throw new Error('Run pnpm notices to update the third-party notices.');
} else {
  writeFileSync(file, output, 'utf8');
  console.log(`Wrote notices for ${entries.length} packages and ${byText.size} distinct texts.`);
}
