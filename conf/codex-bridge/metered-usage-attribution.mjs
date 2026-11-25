// Validate the observed gateway's optional token breakdown without retaining
// message IDs or double-counting it. Only top-level usage supplies quantities.
// Unknown categories, nonzero cache writes and malformed breakdowns fail closed.
const counters = ['input_tokens', 'output_tokens', 'cached_tokens', 'cache_write_tokens']
export function usageAttribution(event) {
  let invalid = false
  const bad = () => { invalid = true }
  function value(parent, key, kind) {
    if (!parent) return kind === 'object' ? (event ? 'envelope' : 'response') : 'skip'
    if (parent === 'envelope' && key === 'response' && kind === 'object') return 'response'
    if (parent === 'response' && key === 'usage' && kind === 'object') return 'usage'
    if (parent === 'usage' && key === 'attribution') {
      if (kind !== 'object') bad()
      return 'attribution'
    }
    if (parent === 'attribution') {
      if (['items', 'request_fields'].includes(key) && kind === 'object') return 'map'
      bad(); return 'skip'
    }
    if (parent === 'map' || parent === 'content') {
      if (kind === 'object') return { entry: true, content: parent === 'content', counts: {} }
      bad(); return 'skip'
    }
    if (parent?.entry) {
      if (counters.includes(key) && kind === 'atom') return { owner: parent, counter: key }
      if (key === 'content' && !parent.content && kind === 'array') return 'content'
      bad(); return 'skip'
    }
    return 'skip'
  }
  return { value, atom(role, raw) {
    if (!role?.owner) return
    const n = Number(raw)
    if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(n) || role.counter === 'cache_write_tokens' && n !== 0) bad()
    role.owner.counts[role.counter] = n
  }, close(role, keys) {
    if (role?.entry && (!keys || counters.some(k => !keys.has(k)) || role.counts.cached_tokens > role.counts.input_tokens)) bad()
    if (role === 'attribution' && (!keys || !keys.has('items') || !keys.has('request_fields'))) bad()
  }, invalid: () => invalid }
}
