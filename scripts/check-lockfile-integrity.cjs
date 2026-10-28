#!/usr/bin/env node
'use strict'

const { readFileSync } = require('fs')
const { resolve } = require('path')

const REGISTRY = 'https://registry.npmjs.org/'

function expectedTarball(path, version) {
  const index = path.lastIndexOf('node_modules/')
  const name = index === -1 ? '' : path.slice(index + 'node_modules/'.length)
  return `${REGISTRY}${name}/-/${name.slice(name.lastIndexOf('/') + 1)}-${version}.tgz`
}

function findLockfileProblems(lock) {
  const problems = []
  for (const [name, entry] of Object.entries(lock.packages ?? {})) {
    if (!name || entry.link) continue 
    if (!entry.resolved || !entry.integrity) problems.push(`${name}: missing resolved/integrity`)
    else if (!entry.resolved.startsWith(REGISTRY)) problems.push(`${name}: resolved outside ${REGISTRY}`)
    else if (!/^sha512-[A-Za-z0-9+/]+=*$/.test(entry.integrity)) problems.push(`${name}: integrity is not sha512`)
    else if (entry.resolved !== expectedTarball(name, entry.version)) problems.push(`${name}: resolved is not the registry tarball for this package and version`)
  }
  return problems
}

module.exports = { findLockfileProblems }

if (require.main === module) {
  const path = resolve(process.argv[2] ?? 'package-lock.json')
  const problems = findLockfileProblems(JSON.parse(readFileSync(path, 'utf8')))
  if (problems.length) {
    console.error(`${problems.length} lockfile entries are not content-pinned:\n  ${problems.join('\n  ')}`)
    process.exit(1)
  }
  console.log('package-lock.json: every dependency has a registry URL and sha512 integrity')
}
