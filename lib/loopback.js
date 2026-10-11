/**
 * ============================================================================
 * 环回信任围栏（loopback trust fence）
 * ============================================================================
 *
 * 【为什么必须有这个文件】
 *   DSH 的 webServer **没有**请求级网关，监听地址也可能被配置成 0.0.0.0。
 *   也就是说：插件注册的路由默认对局域网敞开。任何插件都必须自己围栏自己的
 *   路由，否则同一网络里的其他人就能读取你的缓存统计/提示词指纹。
 *
 * 【判定口径】（与 dsh-pet / remote-web-ui 家族保持一致的语义）
 *   1. socket 远端地址必须属于环回：IPv4 127/8、IPv6 ::1、IPv4-mapped ::ffff:127/8；
 *   2. Host 头必须是环回权威（localhost / [::1] / 127/8）；
 *   3. 浏览器同源标记：sec-fetch-site 不能是 cross-site；
 *      若带 Origin，其 host 必须与 Host 完全一致。
 *   socket 地址是权威依据，X-Forwarded-For 一律不信任。
 *
 * 本文件零依赖（只用 node 内建类型），可被任意插件直接复制使用。
 * ============================================================================
 */

/** IPv4 127/8 判定（四段十进制，首段为 127）。 */
export function isIPv4Loopback(v4) {
  const parts = String(v4).split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
}

/** socket 远端地址是否属于环回段。 */
export function isLoopbackAddress(address) {
  if (address === undefined || address === null) return false
  const normalized = String(address).toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/** Host 名是否是环回权威。 */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/**
 * 请求级围栏：环回 socket + 环回 Host + 浏览器同源标记。
 * @param {import('node:http').IncomingMessage} request - 待判定的请求。
 * @returns {boolean} true = 放行。
 */
export function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request?.socket?.remoteAddress)) return false
  const host = request.headers?.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}
