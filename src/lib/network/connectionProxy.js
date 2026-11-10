// Per-connection proxy configuration.
//
// Proxy Pools were removed from this fork: only the legacy per-connection proxy
// fields (connectionProxyEnabled / connectionProxyUrl / connectionNoProxy) are
// honoured now. Stored `proxyPoolId` values on existing connections are ignored.

// Safely normalize any value into a trimmed string.
function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/**
 * Normalize legacy proxy configuration.
 */
function normalizeLegacyProxy(providerSpecificData = {}) {
  const connectionProxyEnabled =
    providerSpecificData?.connectionProxyEnabled === true;

  const connectionProxyUrl = normalizeString(
    providerSpecificData?.connectionProxyUrl
  );

  const connectionNoProxy = normalizeString(
    providerSpecificData?.connectionNoProxy
  );

  return {
    connectionProxyEnabled,
    connectionProxyUrl,
    connectionNoProxy,
  };
}

/**
 * Resolve final proxy configuration.
 *
 * Priority:
 * 1. Legacy per-connection proxy
 * 2. No Proxy
 */
export async function resolveConnectionProxyConfig(
  providerSpecificData = {}
) {
  try {
    const legacy = normalizeLegacyProxy(providerSpecificData);

    if (legacy.connectionProxyEnabled && legacy.connectionProxyUrl) {
      return {
        source: "legacy",
        ...legacy,
      };
    }

    return {
      source: "none",
      ...legacy,
    };
  } catch (error) {
    console.error(
      "[resolveConnectionProxyConfig] Failed to resolve proxy config:",
      error
    );

    return {
      source: "error",
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",
      strictProxy: false,
    };
  }
}
