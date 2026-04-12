/**
 * scripts/lib/toxiproxy.mjs
 *
 * Helper library for managing Toxiproxy toxics during chaos tests.
 * Communicates with the Toxiproxy HTTP API (default http://localhost:8474).
 *
 * Usage:
 *   import { addToxic, removeToxic, resetProxy, listProxies } from "./lib/toxiproxy.mjs";
 *   await addToxic("postgres", { type: "latency", attributes: { latency: 200 } });
 *   await removeToxic("postgres", "latency_downstream");
 *   await resetProxy("postgres");
 */

const DEFAULT_API_URL = "http://localhost:8474";

/**
 * @param {string} [apiUrl]
 * @returns {{ apiUrl: string }}
 */
function resolveConfig(apiUrl) {
  return {
    apiUrl: apiUrl ?? process.env.TOXIPROXY_API_URL ?? DEFAULT_API_URL
  };
}

/**
 * List all configured proxies.
 * @param {{ apiUrl?: string }} [opts]
 * @returns {Promise<Record<string, object>>}
 */
export async function listProxies(opts) {
  const { apiUrl } = resolveConfig(opts?.apiUrl);
  const res = await fetch(`${apiUrl}/proxies`);
  if (!res.ok) throw new Error(`Toxiproxy listProxies failed: ${res.status}`);
  return res.json();
}

/**
 * Get the current state of a single proxy.
 * @param {string} proxyName
 * @param {{ apiUrl?: string }} [opts]
 * @returns {Promise<object>}
 */
export async function getProxy(proxyName, opts) {
  const { apiUrl } = resolveConfig(opts?.apiUrl);
  const res = await fetch(`${apiUrl}/proxies/${encodeURIComponent(proxyName)}`);
  if (!res.ok) throw new Error(`Toxiproxy getProxy(${proxyName}) failed: ${res.status}`);
  return res.json();
}

/**
 * Add a toxic to a proxy.
 *
 * @param {string} proxyName - "postgres" or "openclaw"
 * @param {{ type: string, name?: string, stream?: "upstream"|"downstream", toxicity?: number, attributes?: Record<string, unknown> }} toxic
 * @param {{ apiUrl?: string }} [opts]
 * @returns {Promise<object>} The created toxic
 *
 * Common toxic types:
 *   - latency:    { latency: 200, jitter: 50 }
 *   - timeout:    { timeout: 5000 }
 *   - reset_peer: { timeout: 0 }
 *   - bandwidth:  { rate: 1 }  (KB/s)
 *   - slicer:     { average_size: 1, size_variation: 0, delay: 10 }
 */
export async function addToxic(proxyName, toxic, opts) {
  const { apiUrl } = resolveConfig(opts?.apiUrl);
  const body = {
    name: toxic.name ?? `${toxic.type}_${toxic.stream ?? "downstream"}`,
    type: toxic.type,
    stream: toxic.stream ?? "downstream",
    toxicity: toxic.toxicity ?? 1.0,
    attributes: toxic.attributes ?? {}
  };
  const res = await fetch(
    `${apiUrl}/proxies/${encodeURIComponent(proxyName)}/toxics`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Toxiproxy addToxic(${proxyName}, ${toxic.type}) failed: ${res.status} ${text}`);
  }
  return res.json();
}

/**
 * Remove a toxic from a proxy by name.
 * @param {string} proxyName
 * @param {string} toxicName
 * @param {{ apiUrl?: string }} [opts]
 */
export async function removeToxic(proxyName, toxicName, opts) {
  const { apiUrl } = resolveConfig(opts?.apiUrl);
  const res = await fetch(
    `${apiUrl}/proxies/${encodeURIComponent(proxyName)}/toxics/${encodeURIComponent(toxicName)}`,
    { method: "DELETE" }
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`Toxiproxy removeToxic(${proxyName}, ${toxicName}) failed: ${res.status}`);
  }
}

/**
 * Remove all toxics from a proxy (reset to clean pass-through).
 * @param {string} proxyName
 * @param {{ apiUrl?: string }} [opts]
 */
export async function resetProxy(proxyName, opts) {
  const proxy = await getProxy(proxyName, opts);
  const toxics = proxy.toxics ?? [];
  for (const toxic of toxics) {
    await removeToxic(proxyName, toxic.name, opts);
  }
}

/**
 * Remove all toxics from all proxies.
 * @param {{ apiUrl?: string }} [opts]
 */
export async function resetAllProxies(opts) {
  const proxies = await listProxies(opts);
  for (const name of Object.keys(proxies)) {
    await resetProxy(name, opts);
  }
}

/**
 * Disable a proxy entirely (drop all connections).
 * @param {string} proxyName
 * @param {{ apiUrl?: string }} [opts]
 */
export async function disableProxy(proxyName, opts) {
  const { apiUrl } = resolveConfig(opts?.apiUrl);
  const res = await fetch(
    `${apiUrl}/proxies/${encodeURIComponent(proxyName)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false })
    }
  );
  if (!res.ok) throw new Error(`Toxiproxy disableProxy(${proxyName}) failed: ${res.status}`);
}

/**
 * Re-enable a previously disabled proxy.
 * @param {string} proxyName
 * @param {{ apiUrl?: string }} [opts]
 */
export async function enableProxy(proxyName, opts) {
  const { apiUrl } = resolveConfig(opts?.apiUrl);
  const res = await fetch(
    `${apiUrl}/proxies/${encodeURIComponent(proxyName)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true })
    }
  );
  if (!res.ok) throw new Error(`Toxiproxy enableProxy(${proxyName}) failed: ${res.status}`);
}

/**
 * Wait for the Toxiproxy API to be reachable.
 * @param {{ apiUrl?: string, timeoutMs?: number, intervalMs?: number }} [opts]
 */
export async function waitForToxiproxy(opts) {
  const { apiUrl } = resolveConfig(opts?.apiUrl);
  const deadline = Date.now() + (opts?.timeoutMs ?? 30_000);
  const interval = opts?.intervalMs ?? 1_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${apiUrl}/version`, {
        signal: AbortSignal.timeout(2_000)
      });
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Toxiproxy API at ${apiUrl} not reachable within ${opts?.timeoutMs ?? 30_000}ms`);
}

// ── Preset toxic recipes ────────────────────────────────────────────────

/**
 * Inject latency into a proxy.
 * @param {string} proxyName
 * @param {{ latencyMs?: number, jitterMs?: number, apiUrl?: string }} [opts]
 */
export async function injectLatency(proxyName, opts) {
  return addToxic(proxyName, {
    type: "latency",
    name: "chaos_latency",
    attributes: {
      latency: opts?.latencyMs ?? 200,
      jitter: opts?.jitterMs ?? 50
    }
  }, opts);
}

/**
 * Inject a connection timeout into a proxy.
 * @param {string} proxyName
 * @param {{ timeoutMs?: number, apiUrl?: string }} [opts]
 */
export async function injectTimeout(proxyName, opts) {
  return addToxic(proxyName, {
    type: "timeout",
    name: "chaos_timeout",
    attributes: { timeout: opts?.timeoutMs ?? 5_000 }
  }, opts);
}

/**
 * Inject a TCP reset (connection drop) into a proxy.
 * @param {string} proxyName
 * @param {{ apiUrl?: string }} [opts]
 */
export async function injectResetPeer(proxyName, opts) {
  return addToxic(proxyName, {
    type: "reset_peer",
    name: "chaos_reset_peer",
    attributes: { timeout: 0 }
  }, opts);
}

/**
 * Inject bandwidth throttling into a proxy.
 * @param {string} proxyName
 * @param {{ rateKBps?: number, apiUrl?: string }} [opts]
 */
export async function injectBandwidthLimit(proxyName, opts) {
  return addToxic(proxyName, {
    type: "bandwidth",
    name: "chaos_bandwidth",
    attributes: { rate: opts?.rateKBps ?? 1 }
  }, opts);
}
