const IMAGE_PROXY_PATH = '/api/image-proxy'
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

function normalizeHostname(hostname) {
  const host = hostname.toLowerCase()
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

function createConfig(env) {
  return {
    allowedHosts: parseAllowedHosts(env.IMAGE_PROXY_ALLOWED_HOSTS),
    maxBytes: parsePositiveInt(env.IMAGE_PROXY_MAX_BYTES, DEFAULT_MAX_BYTES),
    timeoutMs: parsePositiveInt(env.IMAGE_PROXY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxRedirects: parsePositiveInt(env.IMAGE_PROXY_MAX_REDIRECTS, DEFAULT_MAX_REDIRECTS),
  }
}

function isHostAllowed(hostname, config) {
  if (!config.allowedHosts.length) return false

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

function isPrivateIpv4(address) {
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
    (a === 198 && (b === 18 || b === 19))
  )
}

function isPrivateHost(hostname) {
  const host = normalizeHostname(hostname)
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isPrivateIpv4(host)
  if (host === '::' || host === '::1') return true
  if (host.startsWith('::ffff:')) return isPrivateIpv4(host.slice(7))
  if (!host.includes(':')) return false

  const first = parseInt(host.split(':')[0] || '0', 16)
  if (!Number.isFinite(first)) return false
  return (
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    host.startsWith('2001:db8:')
  )
}

function validateTargetUrl(target, config) {
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
  if (isPrivateHost(url.hostname)) {
    throw new ImageProxyError(403, '图片代理拒绝访问本机或内网地址')
  }

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
  const url = validateTargetUrl(target, config)
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

async function handleImageProxyRequest(request, env) {
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

  const config = createConfig(env)
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === IMAGE_PROXY_PATH) return handleImageProxyRequest(request, env)
    return env.ASSETS.fetch(request)
  },
}
