/** Host execution primitive. The caller must bind the exact API authorization and
 * active turn before exposing this operation. This is not a capability registry. */
import { randomUUID } from 'node:crypto'
import { prepareNativeImageCall, NATIVE_IMAGE_MAX_INPUT_BYTES } from './native-image-transport.mjs'

const fail = code => { throw Object.assign(new Error(code), { code }) }
const unknownEvidence = Object.freeze({ providerRequestId: null, responseModel: null, usage: null })
const label = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value) ? value : null
const usageFields = { input_tokens: true, output_tokens: true, total_tokens: true, cached_tokens: true,
  input_tokens_details: { text_tokens: true, image_tokens: true, cached_tokens: true,
    cached_tokens_details: { text_tokens: true, image_tokens: true } },
  output_tokens_details: { text_tokens: true, image_tokens: true } }
function selectCounters(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return Object.fromEntries(Object.entries(fields).filter(([key]) => Object.hasOwn(value, key)).map(([key, shape]) => {
    const field = value[key]
    return [key, shape === true ? (Number.isSafeInteger(field) && field >= 0 ? field : null) : selectCounters(field, shape)]
  }))
}

export function prepareNativeImageInvocation({ store, checkActive, inputRefs = [], pricing = {},
  operation, model, subjectHome, chatProvider, configReadback, fetchFn }) {
  if (typeof checkActive !== 'function' || !label(model)) fail('NATIVE_IMAGE_CONFIG_INVALID')
  if (!Array.isArray(inputRefs) || inputRefs.length > 4 || new Set(inputRefs).size !== inputRefs.length
      || (operation === 'edit') !== Boolean(inputRefs.length)) fail('NATIVE_IMAGE_INPUT_INVALID')
  const refs = [...inputRefs]
  const rate = { channel: label(pricing.channel), tier: label(pricing.tier), priceVersion: label(pricing.priceVersion) }
  return async ({ prompt, signal } = {}) => {
    checkActive()
    if (signal?.aborted) fail('NATIVE_IMAGE_CANCELLED')
    let left = NATIVE_IMAGE_MAX_INPUT_BYTES
    const inputs = refs.map(ref => {
      if (!left) fail('NATIVE_IMAGE_INPUT_INVALID')
      const input = store.readFrozenInput(ref, left)
      left -= input.bytes.length
      return input
    })
    let invocationId, terminalAttempted = false
    const record = (phase, evidence) => store.write(`provider-usage-${invocationId}-${phase.toLowerCase()}`, {
      schemaVersion: 1, invocationId, protocol: 'openai-images-v1', ...rate,
      requestedModel: model, operation, phase, observedAt: Date.now(), evidence
    })
    const complete = evidence => {
      // Even a journal write failure must not replace received evidence with unknown.
      terminalAttempted = true
      record('TERMINAL', evidence)
    }
    const call = prepareNativeImageCall({ operation, model, subjectHome, chatProvider, configReadback, fetchFn, inputs,
      reserveOnce() {
        checkActive()
        // One image effect per execution, not per model call ID or output filename.
        if (!store.reserve('native-image-start')) return false
        invocationId = randomUUID()
        try { record('STARTED', null) } catch (error) { invocationId = null; throw error }
        return true
      },
      observeResponse({ providerRequestId, responseModel, usage }) {
        complete({ providerRequestId: label(providerRequestId), responseModel: label(responseModel), usage: responseModel != null && label(responseModel) === null ? null : selectCounters(usage, usageFields) })
      }
    })
    try {
      const bytes = await call({ prompt, signal })
      checkActive()
      return bytes
    } catch (error) {
      if (invocationId && !terminalAttempted) complete(unknownEvidence)
      throw error
    }
  }
}
