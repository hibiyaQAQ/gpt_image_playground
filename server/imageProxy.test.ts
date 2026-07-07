import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleImageProxyRequest } from './imageProxy.mjs'

afterEach(() => {
  vi.restoreAllMocks()
})

function proxyRequest(src) {
  return new Request(`http://localhost/api/image-proxy?url=${encodeURIComponent(src)}`)
}

describe('image proxy handler', () => {
  it('rejects URLs outside the allowlist', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    const response = await handleImageProxyRequest(proxyRequest('https://cdn.example.com/a.png'), {
      allowedHosts: 'images.example.com',
    })

    expect(response.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects IPv6 localhost targets', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    const response = await handleImageProxyRequest(proxyRequest('http://[::1]/a.png'), {
      allowAllWhenEmpty: true,
    })

    expect(response.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects reserved benchmark IP targets by default', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    const response = await handleImageProxyRequest(proxyRequest('https://198.18.0.46/a.png'), {
      allowedHosts: '198.18.0.46',
    })

    expect(response.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('allows reserved benchmark IP targets when enabled for local fake-ip DNS', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    }))

    const response = await handleImageProxyRequest(proxyRequest('https://198.18.0.46/a.png'), {
      allowedHosts: '198.18.0.46',
      allowReservedBenchmarkIps: true,
    })

    expect(response.status).toBe(200)
  })

  it('rejects images above the size limit', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': '4',
      },
    }))

    const response = await handleImageProxyRequest(proxyRequest('https://8.8.8.8/a.png'), {
      allowedHosts: '8.8.8.8',
      maxBytes: 3,
    })

    expect(response.status).toBe(413)
  })

  it('returns timeout when the upstream request hangs', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal
      if (!(signal instanceof AbortSignal)) return
      signal.addEventListener('abort', () => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        reject(err)
      })
    }))

    const response = await handleImageProxyRequest(proxyRequest('https://8.8.8.8/a.png'), {
      allowedHosts: '8.8.8.8',
      timeoutMs: 1,
    })

    expect(response.status).toBe(504)
  })
})
