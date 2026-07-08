import { handleUrlImageGenerateRequest, jsonResponse } from '../server/urlImageGenerateProxy.mjs'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    const r = jsonResponse(204, {})
    for (const [key, value] of Object.entries(r.headers)) {
      res.setHeader(key, value)
    }
    res.status(204).end()
    return
  }

  if (req.method !== 'POST') {
    const r = jsonResponse(405, { error: '只支持 POST 请求' })
    for (const [key, value] of Object.entries(r.headers)) {
      res.setHeader(key, value)
    }
    res.status(405).send(r.body)
    return
  }

  const r = await handleUrlImageGenerateRequest(req.body)
  for (const [key, value] of Object.entries(r.headers)) {
    res.setHeader(key, value)
  }
  res.status(r.statusCode).send(r.body)
}
