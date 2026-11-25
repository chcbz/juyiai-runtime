import { readFileSync, writeFileSync } from 'node:fs'
import { AlphaAction, Gravity, ImageMagick, MagickColors, MagickFormat, MagickGeometry } from '../vendor/magick.mjs'
import { normalizeImageInput, parseImageOutputSize } from './image-input.mjs'

function main(argv) {
  const args = new Map()
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1]
    if (!['--input', '--output', '--size', '--size-from', '--background'].includes(key) || args.has(key) || !value || value.startsWith('--')) throw Error('无效或重复参数')
    args.set(key, value)
  }
  const input = args.get('--input'), output = args.get('--output')
  const sizeText = args.get('--size'), reference = args.get('--size-from')
  const background = args.get('--background') ?? 'transparent'
  if (!input || !output || Boolean(sizeText) === Boolean(reference) || !['transparent', 'white'].includes(background))
    throw Error('需要 --input、--output，以及 --size 或 --size-from（二选一）；--background 仅支持 transparent 或 white')
  const { width, height } = reference ? normalizeImageInput(readFileSync(reference)) : parseImageOutputSize(sizeText)
  const source = normalizeImageInput(readFileSync(input))
  const color = background === 'white' ? MagickColors.White : MagickColors.Transparent
  const png = ImageMagick.read(source.bytes, MagickFormat.Png, image => {
    image.resize(width, height)
    image.extent(new MagickGeometry(width, height), Gravity.Center, color)
    if (background === 'white') {
      image.backgroundColor = MagickColors.White
      image.alpha(AlphaAction.Remove)
    }
    image.settings.setDefine(MagickFormat.Png, 'exclude-chunks', 'date,time')
    return image.write(background === 'white' ? MagickFormat.Png24 : MagickFormat.Png, data => Buffer.from(data))
  })
  ImageMagick.read(png, MagickFormat.Png, image => {
    if (image.width !== width || image.height !== height || (background === 'white' && image.hasAlpha)) throw Error('输出尺寸或背景透明度校验失败')
  })
  // O_EXCL: the original, a symlink, and an already-existing result cannot be overwritten.
  writeFileSync(output, png, { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ path: output, width, height, background, byteLength: png.length, contentMimeType: 'image/png' }))
}
try { main(process.argv.slice(2)) } catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
