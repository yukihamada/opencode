interface ImportMetaEnv {
  readonly SENTE_CHANNEL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "virtual:sente-server" {
  export namespace Server {
    export const listen: typeof import("../../../sente/dist/types/src/node").Server.listen
    export type Listener = import("../../../sente/dist/types/src/node").Server.Listener
  }
  export namespace Config {
    export const get: typeof import("../../../sente/dist/types/src/node").Config.get
    export type Info = import("../../../sente/dist/types/src/node").Config.Info
  }
  export const bootstrap: typeof import("../../../sente/dist/types/src/node").bootstrap
}
