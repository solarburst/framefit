import { readFile } from "node:fs/promises"
import path from "node:path"
import react from "@vitejs/plugin-react"
import type { Connect, Plugin } from "vite"
import { defineConfig } from "vite"

const mockDir = path.resolve(import.meta.dirname, "mock")

/** GET /api/<name> answers with mock/<name>.json, like a backend the screen would call. */
function mockApi(): Plugin {
  const attach = (server: Connect.Server) => {
    server.use("/api", async (request, response, next) => {
      const name = (request.url ?? "").split("?")[0]!.replace(/^\/+|\/+$/g, "")
      if (!/^[\w/-]+$/.test(name)) return next()
      try {
        const body = await readFile(path.join(mockDir, `${name}.json`), "utf8")
        response.setHeader("content-type", "application/json; charset=utf-8")
        response.end(body)
      } catch {
        response.statusCode = 404
        response.end(JSON.stringify({ error: `mock/${name}.json not found` }))
      }
    })
  }
  return {
    name: "mock-api",
    configureServer: (server) => attach(server.middlewares),
    configurePreviewServer: (server) => attach(server.middlewares),
  }
}

export default defineConfig({
  plugins: [react(), mockApi()],
  server: { host: "127.0.0.1", port: 4174, strictPort: true },
})
