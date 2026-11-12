/**
 * Build the `@shellraining/dsh-workspace-folders` bundle from this package.
 *
 * The package keeps its upstream manifest so the monorepo resolves it as
 * usual. This script type-checks it under that name, then rewrites the
 * manifest to the fork name only while Typert generation and the bundler run
 * (both read the name: Typert ids, the Client loader id, and CSS keys), and
 * stages a publishable directory from the result. The upstream manifest is
 * restored and its Typert artifacts regenerated before the script exits.
 *
 * Usage, from any directory:
 *   node packages/client/ui-workspace/fork/build.ts [--out <dir>] [--pack]
 *
 * `--out` defaults to `fork/dist`. A profile that links the staged directory
 * should use an `--out` outside this repository, so its imports resolve from
 * the DSH installation as an installed package's would. `--pack` also writes
 * the npm tarball beside the staged directory and prints its path.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

interface Manifest {
  name: string
  version: string
  description?: string
  peerDependencies?: Record<string, string>
  dsh?: { client?: unknown }
  [field: string]: unknown
}

const forkDir = import.meta.dirname
const packageDir = dirname(forkDir)
const root = resolve(packageDir, '../../..')
const { values } = parseArgs({ options: { out: { type: 'string' }, pack: { type: 'boolean', default: false } } })
const outDir = resolve(values.out ?? join(forkDir, 'dist'))
const manifestPath = join(packageDir, 'package.json')
const upstreamText = readFileSync(manifestPath, 'utf8')
const upstream = JSON.parse(upstreamText) as Manifest
const overlay = JSON.parse(readFileSync(join(forkDir, 'manifest.json'), 'utf8')) as Manifest

function run(command: string, args: readonly string[], cwd = root): void {
  // LEFTHOOK=0 keeps the upstream git hooks out of any nested git call.
  execFileSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, LEFTHOOK: '0' } })
}

function generateTypert(): void {
  run(process.execPath, ['--import', 'tsx/esm', 'scripts/generate-typert.ts'])
}

/** Replace `workspace:` peer ranges with the linked workspace package's version. */
function resolvePeers(peers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(peers).map(([name, range]) => {
    if (!range.startsWith('workspace:')) return [name, range]
    const linked = JSON.parse(readFileSync(join(packageDir, 'node_modules', name, 'package.json'), 'utf8')) as Manifest
    const prefix = range.slice('workspace:'.length)
    return [name, prefix === '*' ? linked.version : `${prefix}${linked.version}`]
  }))
}

const peers = { ...upstream.peerDependencies, ...overlay.peerDependencies }

// Types and declarations under the upstream name, as the monorepo checks them.
generateTypert()
run(join(root, 'node_modules/.bin/tsc'), ['-b', join(packageDir, 'tsconfig.host.json'), join(packageDir, 'tsconfig.json')])

rmSync(outDir, { recursive: true, force: true })
mkdirSync(join(outDir, 'lib'), { recursive: true })
try {
  // Peers stay external in the Host bundle; Typert ids and the loader id take the fork name.
  writeFileSync(manifestPath, `${JSON.stringify({ ...upstream, name: overlay.name, peerDependencies: peers }, null, 2)}\n`)
  generateTypert()
  run(join(root, 'node_modules/.bin/tsdown'), [], packageDir)
  for (const file of ['index.js', 'client.js', 'client.js.map', 'typert.host.js']) {
    cpSync(join(packageDir, 'lib', file), join(outDir, 'lib', file))
  }
} finally {
  writeFileSync(manifestPath, upstreamText)
  generateTypert()
}

cpSync(join(forkDir, 'locale'), join(outDir, 'locale'), { recursive: true })
for (const file of ['cordis.patch.yml', 'icon.svg', 'README.md']) cpSync(join(forkDir, file), join(outDir, file))
cpSync(join(root, 'LICENSE'), join(outDir, 'LICENSE'))

const published = {
  name: overlay.name,
  version: overlay.version,
  description: overlay.description,
  keywords: overlay.keywords,
  author: overlay.author,
  license: overlay.license,
  homepage: overlay.homepage,
  bugs: overlay.bugs,
  repository: overlay.repository,
  type: 'module',
  main: './lib/index.js',
  icon: './icon.svg',
  exports: {
    '.': './lib/index.js',
    './client': './lib/client.js',
    './typert': './lib/typert.host.js',
    './cordis.patch.yml': './cordis.patch.yml',
    './locale/*.json': './locale/*.json',
    './icon': './icon.svg',
    './package.json': './package.json',
  },
  files: ['lib', 'locale', 'cordis.patch.yml', 'icon.svg', 'README.md', 'LICENSE'],
  engines: overlay.engines,
  dsh: { client: upstream.dsh?.client, bundle: { patch: './cordis.patch.yml' } },
  peerDependencies: resolvePeers(peers),
  publishConfig: { access: 'public' },
}
writeFileSync(join(outDir, 'package.json'), `${JSON.stringify(published, null, 2)}\n`)

if (values.pack) {
  const output = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', dirname(outDir)], {
    cwd: outDir, encoding: 'utf8',
  })) as unknown
  // npm 10 and 11 print an array of results; later versions key them by package name.
  const results = (Array.isArray(output) ? output : Object.values(output as Record<string, unknown>)) as Array<{ filename?: string }>
  const filename = results[0]?.filename
  if (filename === undefined) throw new Error('npm pack reported no tarball')
  console.log(join(dirname(outDir), filename))
}
console.log(`staged ${published.name}@${published.version} in ${outDir}`)
