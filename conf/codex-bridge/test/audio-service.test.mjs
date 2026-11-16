import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
test('offline speech tool protocol, private cache and word alignment regressions', () => {
  execFileSync(process.env.CYF_AUDIO_SERVICE_PYTHON || 'python3', ['-B', '-m', 'unittest', 'discover', '-s', fileURLToPath(new URL('../../../tools/audio-transcription', import.meta.url)), '-p', 'test_service.py', '-v'], { stdio: 'pipe' })
})
