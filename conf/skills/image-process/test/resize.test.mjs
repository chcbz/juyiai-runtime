import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { checkPng, makePng, offlinePackage } from './fixture.mjs'

test('standalone offline skill produces exact opaque white or transparent PNG without modifying either source', t => {
  const dir = mkdtempSync(resolve(tmpdir(), 'cyf-image-process-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const run = offlinePackage(resolve(dir, 'package'))
  const original = makePng(40, 20), reference = makePng(30, 40)
  const input = resolve(dir, 'input.png'), ref = resolve(dir, 'reference.png')
  writeFileSync(input, original); writeFileSync(ref, reference)
  const white = resolve(dir, 'white.png'), transparent = resolve(dir, 'transparent.png')
  let result = run(['--input', input, '--output', white, '--size', '800x600', '--background', 'white'])
  assert.equal(result.status, 0, result.stderr); checkPng(readFileSync(white), 800, 600)
  result = run(['--input', input, '--output', transparent, '--size-from', ref])
  assert.equal(result.status, 0, result.stderr); checkPng(readFileSync(transparent), 30, 40, false)
  const missing = resolve(dir, 'not-created.png')
  for (const flags of [['--size', '1x0'], ['--size', '2x2', '--size-from', ref], ['--size', '2x2', '--background', 'gray']]) {
    assert.equal(run(['--input', input, '--output', missing, ...flags]).status, 1)
    assert.equal(existsSync(missing), false)
  }
  assert.equal(run(['--input', input, '--output', input, '--size', '2x2']).status, 1)
  assert.deepEqual(readFileSync(input), original); assert.deepEqual(readFileSync(ref), reference)
})
