import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Each deployed process installs only the packages its entry point imports.
// The website's main lockfile remains the source of dependency versions.
export const runtimePackages = {
  downloader: ['fflate', 'playwright-core', 'sharp'],
  sync: ['cos-nodejs-sdk-v5'],
}

async function update() {
  if (!process.env.npm_execpath) throw new Error('Run npm run runtime:sync from website.')
  const root = fileURLToPath(new URL('../', import.meta.url))
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const lock = await readFile(path.join(root, 'package-lock.json'))
  for (const [service, packages] of Object.entries(runtimePackages)) {
    const directory = path.join(root, 'deploy/services', service)
    await mkdir(directory, { recursive: true })
    const dependencies = Object.fromEntries(
      packages.map((name) => {
        if (!manifest.dependencies[name]) throw new Error(`Missing dependency: ${name}`)
        return [name, manifest.dependencies[name]]
      }),
    )
    await writeFile(
      path.join(directory, 'package.json'),
      JSON.stringify(
        {
          name: `@caibao/${service}`,
          version: manifest.version,
          private: true,
          type: 'module',
          license: manifest.license,
          engines: manifest.engines,
          dependencies,
        },
        null,
        2,
      ) + '\n',
    )
    // npm removes unrelated packages using its own lockfile resolution rules;
    // seeding the existing lock preserves exact versions and integrity hashes.
    await writeFile(path.join(directory, 'package-lock.json'), lock)
    execFileSync(
      process.execPath,
      [
        process.env.npm_execpath,
        'install',
        '--package-lock-only',
        '--ignore-scripts',
        '--offline',
        '--no-audit',
        '--no-fund',
      ],
      { cwd: directory, stdio: 'inherit' },
    )
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await update()
