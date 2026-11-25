// Plain text only: do not give document contents an HTML or network capability.
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export async function renderTextPdf(text, withBrowser) {
  if (!text.trim()) throw new Error('PDF source text is empty')
  return withBrowser(async ({ page }) => {
    await page.setContent('<meta charset="utf-8"><style>@page{size:A4;margin:18mm}body{font:12pt/1.6 "Noto Sans CJK SC",sans-serif}main{white-space:pre-wrap;overflow-wrap:anywhere}</style><main></main>')
    await page.locator('main').evaluate((element, value) => { element.textContent = value }, text)
    await page.evaluate(() => document.fonts.ready)
    return page.pdf({ preferCSSPageSize: true, printBackground: true })
  })
}

export async function writeTextPdf(source, destination, withBrowser) {
  const pdf = await renderTextPdf(await readFile(source, 'utf8'), withBrowser)
  await writeFile(destination, pdf, { flag: 'wx' })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [source, destination, ...extra] = process.argv.slice(2)
  if (!source || !destination || extra.length) throw new Error('Usage: text-pdf.mjs input.txt output.pdf')
  const { withBrowser } = await import('/usr/lib/cyf-browser/browser-session.mjs')
  await writeTextPdf(source, destination, withBrowser)
}
