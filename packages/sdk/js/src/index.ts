export * from "./client.js"
export * from "./server.js"

import { createSenteClient } from "./client.js"
import { createSenteServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export async function createSente(options?: ServerOptions) {
  const server = await createSenteServer({
    ...options,
  })

  const client = createSenteClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
