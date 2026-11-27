import { skillDigest } from './skill-executor.mjs'

// Source identity only. This preserves existing capture namespace bytes; it is
// neither an Economy billing channel nor proof of coverage/actual billed identity.
export function meteredProviderNamespace(providerId, baseUrl) {
  return skillDigest(['METERED_PROVIDER_NAMESPACE_V1', providerId, new URL(baseUrl).href.replace(/\/$/, '')])
}

// Call from the actual resource adapter after its ordinary endpoint/configuration
// validation. No network, prices, default tier, secrets or business-type dispatch.
export function measuredCostRouteReference({ kind, component, providerId, baseUrl, modelOrTool, normalizationBasis }) {
  const fields = { kind, component, modelOrTool, normalizationBasis }
  if (Object.values(fields).some(v => typeof v !== 'string' || !v.length || [...v].length > 128 || v.trim() !== v)
      || typeof providerId !== 'string' || !providerId.trim()) throw new TypeError('Invalid measured cost route reference')
  return Object.freeze({ kind, component, namespace: meteredProviderNamespace(providerId, baseUrl), modelOrTool, normalizationBasis })
}
