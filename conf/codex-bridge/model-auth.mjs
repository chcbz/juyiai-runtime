// One execution-time model credential source: this subject's CODEX_HOME/auth.json.
// Operator templates provision files; they are never an execution-time fallback.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
const fail = code => { throw Object.assign(new Error(code), { code }) }
const secrets = new Set()
export const redactModelSecrets = text => {
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]')
  return text
}
export const validateModelAuth = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'OPENAI_API_KEY,auth_mode'
      || value.auth_mode !== 'apikey' || typeof value.OPENAI_API_KEY !== 'string'
      || !value.OPENAI_API_KEY.length || value.OPENAI_API_KEY.trim() !== value.OPENAI_API_KEY
      || /[\u0000-\u001f\u007f-\u009f]/u.test(value.OPENAI_API_KEY)) fail('MODEL_AUTH_INVALID')
  secrets.add(value.OPENAI_API_KEY)
  return value
}
export const parseModelAuth = bytes => {
  let value; try { value = JSON.parse(bytes.toString()) } catch { fail('MODEL_AUTH_INVALID') }
  return validateModelAuth(value)
}
export const serializeModelAuth = value => {
  validateModelAuth(value)
  return `${JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: value.OPENAI_API_KEY })}\n`
}
export const readModelAuthFile = home => {
  let fd
  try {
    if (typeof home !== 'string' || resolve(home) !== home || realpathSync(home) !== home) fail('MODEL_AUTH_UNSAFE')
    const root = lstatSync(home)
    if (!root.isDirectory() || root.uid !== process.getuid() || root.mode & 0o077) fail('MODEL_AUTH_UNSAFE')
    fd = openSync(resolve(home, 'auth.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077) fail('MODEL_AUTH_UNSAFE')
    const bytes = readFileSync(fd); const auth = parseModelAuth(bytes)
    return { bytes, auth }
  } catch (error) {
    if (error.code?.startsWith('MODEL_AUTH_')) throw error
    fail(error.code === 'ENOENT' ? 'MODEL_AUTH_REQUIRED' : 'MODEL_AUTH_UNSAFE')
  } finally { if (fd !== undefined) closeSync(fd) }
}
export const assertFileAuthConfig = (readback, expected = null) => {
  const config = readback?.config; const provider = config?.model_providers?.[config.model_provider]
  if (config?.cli_auth_credentials_store !== 'file' || !provider || provider.requires_openai_auth !== true
      || provider.wire_api !== 'responses'
      || ['env_key', 'experimental_bearer_token', 'auth', 'gateway_oauth', 'aws', 'credential_file', 'project_id', 'location', 'query_params', 'http_headers', 'env_http_headers'].some(key => provider[key] != null)
      || expected && (config.model_provider !== expected.id || provider.base_url?.replace(/\/$/, '') !== expected.baseUrl?.replace(/\/$/, '') || provider.wire_api !== expected.wireApi)) fail('MODEL_AUTH_CONFIG_INVALID')
  return provider
}
