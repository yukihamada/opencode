const stage = process.env.SST_STAGE || "dev"

export default {
  url: stage === "production" ? "https://teai.io/sente" : `https://${stage}.teai.io/sente`,
  console: stage === "production" ? "https://teai.io/sente/auth" : `https://${stage}.teai.io/sente/auth`,
  email: "help@anoma.ly",
  socialCard: "https://social-cards.sst.dev",
  github: "https://github.com/anomalyco/sente",
  discord: "https://teai.io/sente/discord",
  headerLinks: [
    { name: "app.header.home", url: "/" },
    { name: "app.header.docs", url: "/docs/" },
  ],
}
