import { lookup } from 'node:dns/promises'
import net from 'node:net'

export const IMAGE_PROXY_PATH = '/api/image-proxy'

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_REDIRECTS = 3
const ALLOWED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
])

class ImageProxyError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function parsePositiveInt(value, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return fallback
  return Math.trunc(num)
}

function parseAllowedHosts(value) {
  return String(value || '')
    .split(/[\s,]+/)
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
}

function parseBoolean(value) {
  return value === true || String(value || '').toLowerCase() === 'true'
}

function normalizeHostname(hostname) {
  const host = hostname.toLowerCase()
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

function createConfig(options = {}) {
  return {
    allowedHosts: parseAllowedHosts(options.allowedHosts ?? process.env.IMAGE_PROXY_ALLOWED_HOSTS),
    allowAllWhenEmpty: Boolean(options.allowAllWhenEmpty),
    allowReservedBenchmarkIps: parseBoolean(options.allowReservedBenchmarkIps ?? process.env.IMAGE_PROXY_ALLOW_FAKE_IPS),
    maxBytes: parsePositiveInt(options.maxBytes ?? process.env.IMAGE_PROXY_MAX_BYTES, DEFAULT_MAX_BYTES),
    timeoutMs: parsePositiveInt(options.timeoutMs ?? process.env.IMAGE_PROXY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxRedirects: parsePositiveInt(options.maxRedirects ?? process.env.IMAGE_PROXY_MAX_REDIRECTS, DEFAULT_MAX_REDIRECTS),
  }
}

function isHostAllowed(hostname, config) {
  if (!config.allowedHosts.length) return config.allowAllWhenEmpty

  const host = normalizeHostname(hostname)
  return config.allowedHosts.some((entry) => {
    if (entry === '*') return true
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1)
      return host.endsWith(suffix) && host.length > suffix.length
    }
    return host === entry
  })
}

function isPrivateIpv4(address, config) {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true

  const [a, b] = parts
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (!config.allowReservedBenchmarkIps && a === 198 && (b === 18 || b === 19))
  )
}

function isPrivateIpv6(address, config) {
  const normalized = address.toLowerCase()
  if (normalized === '::' || normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isPrivateIpv4(normalized.slice(7), config)

  const first = parseInt(normalized.split(':')[0] || '0', 16)
  if (!Number.isFinite(first)) return true
  return (
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    normalized.startsWith('2001:db8:')
  )
}

function isPrivateIp(address, config) {
  const version = net.isIP(address)
  if (version === 4) return isPrivateIpv4(address, config)
  if (version === 6) return isPrivateIpv6(address, config)
  return true
}

async function assertPublicTarget(url, config) {
  const host = normalizeHostname(url.hostname)
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new ImageProxyError(403, '图片代理拒绝访问本机地址')
  }

  if (net.isIP(host)) {
    if (isPrivateIp(host, config)) throw new ImageProxyError(403, '图片代理拒绝访问内网地址')
    return
  }

  const addresses = await lookup(host, { all: true, verbatim: true })
  if (!addresses.length) throw new ImageProxyError(400, '图片 URL 域名无法解析')
  if (addresses.some((item) => isPrivateIp(item.address, config))) {
    throw new ImageProxyError(403, '图片代理拒绝访问解析到内网的地址')
  }
}

async function validateTargetUrl(target, config) {
  let url
  try {
    url = new URL(target)
  } catch {
    throw new ImageProxyError(400, '图片 URL 格式无效')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ImageProxyError(400, '图片代理只允许 HTTP/HTTPS URL')
  }
  if (url.username || url.password) {
    throw new ImageProxyError(400, '图片 URL 不能包含用户名或密码')
  }
  if (!isHostAllowed(url.hostname, config)) {
    throw new ImageProxyError(403, '图片 URL 不在代理 allowlist 内')
  }

  await assertPublicTarget(url, config)
  return url
}

function createJsonResponse(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function isRedirectResponse(response) {
  return [301, 302, 303, 307, 308].includes(response.status)
}

async function fetchWithValidation(target, config, signal, redirectCount = 0) {
  const url = await validateTargetUrl(target, config)
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    signal,
    headers: {
      Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.5',
      'User-Agent': 'gpt-image-playground-image-proxy/1.0',
    },
  })

  if (isRedirectResponse(response)) {
    const location = response.headers.get('Location')
    if (!location) throw new ImageProxyError(502, '图片 URL 重定向缺少 Location')
    if (redirectCount >= config.maxRedirects) throw new ImageProxyError(508, '图片 URL 重定向次数过多')
    return fetchWithValidation(new URL(location, url).toString(), config, signal, redirectCount + 1)
  }

  return response
}

async function readLimitedBody(response, maxBytes) {
  if (!response.body) throw new ImageProxyError(502, '图片代理未收到响应内容')

  const chunks = []
  let total = 0
  const reader = response.body.getReader()

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) throw new ImageProxyError(413, '图片文件超过代理大小限制')
    chunks.push(value)
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

export async function handleImageProxyRequest(request, options = {}) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    })
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return createJsonResponse(405, '图片代理只支持 GET/HEAD 请求')
  }

  const config = createConfig(options)
  const requestUrl = new URL(request.url)
  const target = requestUrl.searchParams.get('url')?.trim()
  if (!target) return createJsonResponse(400, '缺少图片 URL')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs)

  try {
    const response = await fetchWithValidation(target, config, controller.signal)
    if (!response.ok) throw new ImageProxyError(response.status, `图片源站返回 HTTP ${response.status}`)

    const contentType = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() ?? ''
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
      throw new ImageProxyError(415, '图片源站返回的内容不是允许的图片类型')
    }

    const contentLength = response.headers.get('Content-Length')
    if (contentLength && Number(contentLength) > config.maxBytes) {
      throw new ImageProxyError(413, '图片文件超过代理大小限制')
    }

    const headers = {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    }

    if (request.method === 'HEAD') {
      return new Response(null, { status: 200, headers })
    }

    const body = await readLimitedBody(response, config.maxBytes)
    headers['Content-Length'] = String(body.byteLength)
    return new Response(body, { status: 200, headers })
  } catch (error) {
    if (error instanceof ImageProxyError) return createJsonResponse(error.status, error.message)
    if (error?.name === 'AbortError') return createJsonResponse(504, '图片代理请求超时')
    console.warn('Image proxy failed:', error)
    return createJsonResponse(502, '图片代理请求失败')
  } finally {
    clearTimeout(timeout)
  }
}
