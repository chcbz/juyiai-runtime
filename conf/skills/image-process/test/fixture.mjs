import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ImageMagick, MagickColors, MagickFormat, initializeImageMagick } from '../../native-image/vendor/magick.mjs'

const source = relative => fileURLToPath(new URL(relative, import.meta.url))
await initializeImageMagick(readFileSync(source('../../native-image/vendor/magick.wasm')))
export function offlinePackage(root) {
  mkdirSync(resolve(root, 'scripts'), { recursive: true })
  copyFileSync(source('../scripts/resize.mjs'), resolve(root, 'scripts/resize.mjs'))
  copyFileSync(source('../../native-image/scripts/image-input.mjs'), resolve(root, 'scripts/image-input.mjs'))
  symlinkSync(source('../../native-image/vendor'), resolve(root, 'vendor'))
  return args => spawnSync(process.execPath, [resolve(root, 'scripts/resize.mjs'), ...args], { encoding: 'utf8', env: {} })
}
export function makePng(width, height, color = MagickColors.Red) {
  return ImageMagick.read(color, width, height, image => image.write(MagickFormat.Png, bytes => Buffer.from(bytes)))
}
export function checkPng(bytes, width, height, white = true) {
  if (white) assert.equal(bytes[25], 2, 'white PNG encodes RGB without an alpha channel')
  ImageMagick.read(bytes, MagickFormat.Png, image => {
    assert.equal(image.width, width); assert.equal(image.height, height)
    if (white) {
      assert.equal(image.hasAlpha, false)
      image.getPixels(pixels => assert.deepEqual([...pixels.getPixel(0, 0)].slice(0, 3), [255, 255, 255]))
    } else {
      assert.equal(image.hasAlpha, true)
      image.getPixels(pixels => assert.equal(pixels.getPixel(0, 0)[3], 0))
    }
    image.getPixels(pixels => assert.deepEqual([...pixels.getPixel(Math.floor(width / 2), Math.floor(height / 2))].slice(0, 3), [255, 0, 0]))
  })
}
