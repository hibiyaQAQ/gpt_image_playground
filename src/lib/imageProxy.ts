export const IMAGE_PROXY_PATH = '/api/image-proxy'

export function getImageProxyUrl(src: string): string {
  if (!/^https?:\/\//i.test(src)) return src
  const params = new URLSearchParams({ url: src })
  return `${IMAGE_PROXY_PATH}?${params.toString()}`
}
