import { appendFile } from "node:fs/promises"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const log = process.env.MCP_LAZY_LOG
if (!log) throw new Error("MCP_LAZY_LOG is required")
await appendFile(log, process.pid + "\n")

const server = new Server({ name: "mcp-lazy-stdio", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, () =>
  Promise.resolve({
    tools: [{ name: "whoami", description: "live", inputSchema: { type: "object", properties: {} } }],
  }),
)

server.setRequestHandler(CallToolRequestSchema, () =>
  Promise.resolve({ content: [{ type: "text", text: String(process.pid) }] }),
)

await server.connect(new StdioServerTransport())
