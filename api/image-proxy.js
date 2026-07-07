import { handleImageProxyRequest } from '../server/imageProxy.mjs'

export default async function handler(req, res) {
  const proto = Array.isArray(req.headers['x-forwarded-proto'])
    ? req.headers['x-forwarded-proto'][0]
    : req.headers['x-forwarded-proto'] || 'https'
  const host = req.headers.host || 'localhost'
  const request = new Request(`${proto}://${host}${req.url}`, {
    method: req.method || 'GET',
  })
  const response = await handleImageProxyRequest(request)

  res.statusCode = response.status
  response.headers.forEach((value, key) => res.setHeader(key, value))
  if (req.method === 'HEAD') {
    res.end()
    return
  }

  res.end(Buffer.from(await response.arrayBuffer()))
}
