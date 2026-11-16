import assert from 'node:assert/strict'
import test from 'node:test'
import { parseNativeApiOrigin } from '../native-api-origin.mjs'

test('native API origins retain HTTPS and explicit loopback HTTP', () => {
  for (const value of ['https://api.example.test', 'https://api.example.test:8443',
    'http://localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080']) {
    assert.equal(parseNativeApiOrigin(value), value)
  }
})
test('native API origins reject credentials, arbitrary HTTP, paths and query secrets', () => {
  for (const value of ['invalid', 'file:///tmp/a', 'http://api.example.test',
    'https://user:secret@api.example.test', 'https://api.example.test/path',
    'https://api.example.test/?token=secret', 'https://api.example.test/#hash',
    'http://127.0.0.999:8080', 'http://127.example.test']) {
    assert.throws(() => parseNativeApiOrigin(value), { code: 'CONFIG_INVALID' })
  }
})
