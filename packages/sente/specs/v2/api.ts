// @ts-nocheck

import { Sente } from "@sente-ai/core"
import { ReadTool } from "@sente-ai/core/tools"

const sente = Sente.make({})

sente.tool.add(ReadTool)

sente.tool.add({
  name: "bash",
  schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to run.",
      },
    },
    required: ["command"],
  },
  execute(input, ctx) {},
})

sente.auth.add({
  provider: "openai",
  type: "api",
  value: process.env.OPENAI_API_KEY,
})

sente.agent.add({
  name: "build",
  permissions: [],
  model: {
    id: "gpt-5-5",
    provider: "openai",
    variant: "xhigh",
  },
})

const sessionID = await sente.session.create({
  agent: "build",
})

sente.subscribe((event) => {
  console.log(event)
})

await sente.session.prompt({
  sessionID,
  text: "hey what is up",
})

await sente.session.prompt({
  sessionID,
  text: "what is up with this",
  files: [
    {
      mime: "image/png",
      uri: "data:image/png;base64,xxxx",
    },
  ],
})

await sente.session.wait()

console.log(await sente.session.messages(sessionID))
