const MIN_TIMEOUT_MS = 5000
const DEFAULT_TIMEOUT_MS = Number(process.env.IMAGE_API_TIMEOUT_MS || 110000)
const MAX_TIMEOUT_MS = Number(process.env.IMAGE_API_MAX_TIMEOUT_MS || 900000)

export const URL_IMAGE_GENERATE_PATH = '/api/generate'

export function jsonResponse(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      ...headers,
    },
    body: JSON.stringify(body),
  }
}

function parseJsonBody(rawBody) {
  if (!rawBody) return {}
  if (typeof rawBody === 'object') return rawBody
  return JSON.parse(rawBody)
}

function trimSlashEnd(value) {
  return value.replace(/\/+$/, '')
}

function normalizeTargetUrl(apiBaseUrl, endpointPath) {
  if (!apiBaseUrl || typeof apiBaseUrl !== 'string') {
    throw new Error('Base URL 不能为空')
  }

  const endpoint = String(endpointPath || '').trim()
  const baseUrl = new URL(apiBaseUrl.trim())
  if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
    throw new Error('Base URL 只支持 http 或 https')
  }

  if (!endpoint) return baseUrl.toString()

  const cleanEndpoint = `/${endpoint.replace(/^\/+/, '')}`
  const currentPath = trimSlashEnd(baseUrl.pathname)
  if (currentPath.endsWith(trimSlashEnd(cleanEndpoint))) return baseUrl.toString()

  const baseWithSlash = baseUrl.toString().endsWith('/') ? baseUrl.toString() : `${baseUrl.toString()}/`
  return new URL(cleanEndpoint.slice(1), baseWithSlash).toString()
}

function assertAllowedHost(targetUrl) {
  const allowList = String(process.env.ALLOWED_IMAGE_API_HOSTS || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)

  if (allowList.length === 0) return

  const host = new URL(targetUrl).host.toLowerCase()
  if (!allowList.includes(host)) {
    throw new Error(`目标域名不在允许列表：${host}`)
  }
}

function buildAuthHeaders(authMode, apiKey, customHeaderName) {
  const headers = {}
  const key = String(apiKey || '')
  const mode = String(authMode || 'bearer')

  if (mode === 'none' || !key) return headers

  if (mode === 'bearer') {
    headers.Authorization = key.toLowerCase().startsWith('bearer ') ? key : `Bearer ${key}`
    return headers
  }

  if (mode === 'x-api-key') {
    headers['x-api-key'] = key
    return headers
  }

  if (mode === 'custom') {
    const headerName = String(customHeaderName || '').trim()
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(headerName)) {
      throw new Error('自定义 Header 名称不合法')
    }
    headers[headerName] = key
  }

  return headers
}

function validateRequestBody(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('请求体不能为空')
  }
  if (!Array.isArray(request.images) || request.images.length === 0) {
    throw new Error('images 至少需要一项')
  }
  if (typeof request.prompt !== 'string' || request.prompt.trim() === '') {
    throw new Error('prompt 不能为空')
  }
  if (typeof request.model !== 'string' || request.model.trim() === '') {
    throw new Error('model 不能为空')
  }

  for (const image of request.images) {
    if (!image || typeof image !== 'object' || typeof image.image_url !== 'string') {
      throw new Error('images 每一项都需要 image_url')
    }
  }
}

function normalizeTimeoutMs(timeoutSeconds) {
  const requestedMs = Number(timeoutSeconds) * 1000
  const fallbackMs = Number.isFinite(DEFAULT_TIMEOUT_MS) ? DEFAULT_TIMEOUT_MS : 110000
  const maxMs = Number.isFinite(MAX_TIMEOUT_MS) ? MAX_TIMEOUT_MS : 900000
  const timeoutMs = Number.isFinite(requestedMs) && requestedMs > 0 ? requestedMs : fallbackMs
  return Math.min(Math.max(Math.round(timeoutMs), MIN_TIMEOUT_MS), maxMs)
}

async function callImageApi(payload) {
  validateRequestBody(payload.request)

  const targetUrl = normalizeTargetUrl(payload.apiBaseUrl, payload.endpointPath)
  assertAllowedHost(targetUrl)
  const authHeaders = buildAuthHeaders(payload.authMode, payload.apiKey, payload.customHeaderName)
  const timeoutMs = normalizeTimeoutMs(payload.timeoutSeconds)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify(payload.request),
      signal: controller.signal,
    })

    const contentType = response.headers.get('content-type') || ''
    const raw = await response.text()
    const data = contentType.includes('application/json')
      ? raw ? JSON.parse(raw) : {}
      : { raw }

    if (!response.ok) {
      let message =
        data?.error?.message ||
        (typeof data?.error === 'string' ? data.error : null) ||
        data?.message ||
        '上游未返回错误描述'
      if (typeof message !== 'string') message = JSON.stringify(message)
      return jsonResponse(response.status, {
        error: `上游接口 HTTP ${response.status}：${message}`,
        status: response.status,
        upstream: data,
      })
    }

    return jsonResponse(200, data)
  } catch (error) {
    const message = error.name === 'AbortError'
      ? `上游接口请求超时（${Math.round(timeoutMs / 1000)} 秒）`
      : error.message
    return jsonResponse(500, { error: message })
  } finally {
    clearTimeout(timeout)
  }
}

export async function handleUrlImageGenerateRequest(rawBody) {
  try {
    const payload = parseJsonBody(rawBody)
    return await callImageApi(payload)
  } catch (error) {
    return jsonResponse(400, { error: error.message || '请求参数错误' })
  }
}
