/**
 * Whether remote media can go through the instance's /api/proxy.
 *
 * A wunderkammer server proxies remote covers so they can enter WebGL atlases
 * without the publisher's CORS headers. A collection loaded without a server
 * has no proxy: its remote covers load directly, and the 3D views need the
 * host to send CORS headers (the collection's images.cors).
 */
let proxyAvailable = true;

export function setProxyAvailable(value) { proxyAvailable = !!value; }

/** Route an absolute remote URL through the proxy when there is one. */
export function remote(href) {
  return proxyAvailable ? `/api/proxy?url=${encodeURIComponent(href)}` : href;
}
