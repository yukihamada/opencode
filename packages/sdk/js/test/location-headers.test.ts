import { expect, test } from "bun:test"

for (const version of ["v1", "v2"] as const) {
  test(`${version} sends the server directory header on writes and query on reads`, async () => {
    const source = version === "v1" ? await import("../src/client") : await import("../src/v2/client")
    const requests: Request[] = []
    const client = source.createSenteClient({
      baseUrl: "http://localhost:4096",
      directory: "/fixture repo",
      fetch: async (request) => {
        requests.push(request instanceof Request ? request : new Request(request))
        return Response.json(true)
      },
    })
    await client.instance.dispose()
    await client.path.get()
    expect(requests[0]!.headers.get("x-sente-directory")).toBe("%2Ffixture%20repo")
    expect(requests[0]!.headers.get("x-opencode-directory")).toBeNull()
    expect(new URL(requests[1]!.url).searchParams.get("directory")).toBe("/fixture repo")
    expect(requests[1]!.headers.get("x-sente-directory")).toBeNull()
  })
}
