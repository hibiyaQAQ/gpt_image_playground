import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchImageUrlAsDataUrl } from './imageApiShared'
import { getImageProxyUrl, IMAGE_PROXY_PATH } from './imageProxy'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('image proxy client helpers', () => {
  it('builds same-origin proxy URLs for HTTP images', () => {
    const src = 'https://cdn.example.com/path/a b.webp?x=1&y=2'
    expect(getImageProxyUrl(src)).toBe(`${IMAGE_PROXY_PATH}?url=https%3A%2F%2Fcdn.example.com%2Fpath%2Fa+b.webp%3Fx%3D1%26y%3D2`)
  })

  it('does not proxy data URLs', () => {
    const src = 'data:image/png;base64,AQID'
    expect(getImageProxyUrl(src)).toBe(src)
  })

  it('downloads HTTP image URLs through the image proxy', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })))

    await expect(fetchImageUrlAsDataUrl('https://cdn.example.com/a.png', 'image/png')).resolves.toBe('data:image/png;base64,AQID')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/image-proxy?url=https%3A%2F%2Fcdn.example.com%2Fa.png',
      expect.objectContaining({ cache: 'no-store' }),
    )
  })
})
