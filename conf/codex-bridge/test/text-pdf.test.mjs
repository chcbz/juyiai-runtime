import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeTextPdf, renderTextPdf } from '../../skills/document-workbench/scripts/text-pdf.mjs'

test('blank input never starts the browser', async () => {
  await assert.rejects(renderTextPdf(' \n', () => assert.fail('unexpected launch')), /empty/)
})
test('document is inserted as text, and existing output cannot be replaced', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'text-pdf-'))
  t.after(() => rm(dir, {recursive:true, force:true}))
  const src=join(dir,'input'), dst=join(dir,'output.pdf'), text='中文 <img src="https://example.invalid/i">'
  await writeFile(src,text)
  const render = fn => fn({ page: {
    setContent: async html => assert.ok(!html.includes(text)),
    locator: () => ({ evaluate: (insert, value) => { const element={}; insert(element,value); assert.equal(element.textContent,text) } }),
    evaluate: async () => {}, pdf: async () => Buffer.from('candidate')
  } })
  await writeTextPdf(src,dst,render)
  await writeFile(dst,'previous')
  await assert.rejects(writeTextPdf(src,dst,render),{code:'EEXIST'})
  assert.equal(await readFile(dst,'utf8'),'previous')
})
