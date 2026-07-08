import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
import { normalizeDevProxyConfig } from './src/lib/devProxy'
import { handleImageProxyRequest, IMAGE_PROXY_PATH } from './server/imageProxy.mjs'
import { handleUrlImageGenerateRequest, URL_IMAGE_GENERATE_PATH } from './server/urlImageGenerateProxy.mjs'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

function loadDevProxyConfig() {
  try {
    return normalizeDevProxyConfig(
      JSON.parse(readFileSync('./dev-proxy.config.json', 'utf-8')) as unknown,
    )
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return null
    throw error
  }
}

function imageProxyPlugin() {
  return {
    name: 'image-proxy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const requestUrl = new URL(req.url || '/', 'http://localhost')
        if (requestUrl.pathname !== IMAGE_PROXY_PATH) {
          next()
          return
        }

        const response = await handleImageProxyRequest(
          new Request(requestUrl.toString(), { method: req.method }),
          { allowAllWhenEmpty: true, allowReservedBenchmarkIps: true },
        )
        res.statusCode = response.status
        response.headers.forEach((value, key) => res.setHeader(key, value))
        if (req.method === 'HEAD') {
          res.end()
          return
        }
        res.end(Buffer.from(await response.arrayBuffer()))
      })
    },
  }
}

function readRequestBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function urlImageGeneratePlugin() {
  return {
    name: 'url-image-generate',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const requestUrl = new URL(req.url || '/', 'http://localhost')
        if (requestUrl.pathname !== URL_IMAGE_GENERATE_PATH) {
          next()
          return
        }

        const body = req.method === 'POST' ? await readRequestBody(req) : ''
        const response = req.method === 'OPTIONS'
          ? { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' }
          : await handleUrlImageGenerateRequest(body)
        res.statusCode = response.statusCode
        Object.entries(response.headers).forEach(([key, value]) => res.setHeader(key, value))
        res.end(response.body)
      })
    },
  }
}

export default defineConfig(({ command }) => {
  const devProxyConfig = command === 'serve' ? loadDevProxyConfig() : null

  return {
    plugins: [imageProxyPlugin(), urlImageGeneratePlugin(), react()],
    base: './',
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __DEV_PROXY_CONFIG__: JSON.stringify(devProxyConfig),
    },
    server: {
      host: true,
      proxy:
        devProxyConfig?.enabled
          ? {
              [devProxyConfig.prefix]: {
                target: devProxyConfig.target,
                changeOrigin: devProxyConfig.changeOrigin,
                secure: devProxyConfig.secure,
                rewrite: (path) =>
                  path.replace(
                    new RegExp(`^${devProxyConfig.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
                    '',
                  ),
              },
            }
          : undefined,
    },
  }
})
