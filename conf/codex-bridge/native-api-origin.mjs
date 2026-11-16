// Shared native origin boundary; no execution or filesystem behavior.
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }

const isLoopback = hostname => {
  const host = String(hostname).replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host === '::1') return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  return Boolean(match && match.slice(1).every(part => Number(part) <= 255) && Number(match[1]) === 127)
}

export const parseNativeApiOrigin = value => {
  let url
  try { url = new URL(value) } catch { fail('CONFIG_INVALID', 'apiOrigin must be an absolute URL origin') }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || (url.protocol === 'http:' && !isLoopback(url.hostname))) {
    fail('CONFIG_INVALID', 'apiOrigin must be an HTTPS origin, or an explicit loopback HTTP origin')
  }
  return url.origin
}
