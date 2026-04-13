require("dotenv").config();

module.exports = {
  port: Number(process.env.PORT || 3000),
  jwtSecret: process.env.JWT_SECRET || "change-me",
  ownerDiscordId: process.env.OWNER_DISCORD_ID || "",
  supportDiscordUrl: process.env.SUPPORT_DISCORD_URL || "",
  clientAppName: process.env.CLIENT_APP_NAME || "CodeFrame"
};