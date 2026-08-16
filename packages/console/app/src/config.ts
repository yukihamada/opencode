/**
 * Application-wide constants and configuration
 */
export const config = {
  // Base URL
  baseUrl: "https://teai.io/sente",

  // GitHub
  github: {
    repoUrl: "https://github.com/anomalyco/sente",
    starsFormatted: {
      compact: "195K",
      full: "195,000",
    },
  },

  // Social links
  social: {
    twitter: "https://x.com/sente",
    discord: "https://discord.gg/sente",
  },

  // Static stats (used on landing page)
  stats: {
    contributors: "950",
    commits: "13,000",
    monthlyUsers: "16M",
  },
} as const
