const express = require("express");
const jwt = require("jsonwebtoken");
const { jwtSecret, supportDiscordUrl } = require("../config");
const { upsertUserProfile, getLicenseStatus } = require("../services/licenseService");
const { getDailyUsage } = require("../services/usageService");
const { authRequired } = require("../middleware/auth");

const router = express.Router();

/*
  Na ten moment login jest w trybie DEV/MVP:
  frontend wysyła discordId, username, avatarUrl po poprawnym Discord OAuth.
  Później podmienimy to na pełny callback OAuth Discorda.
*/
router.post("/discord", (req, res) => {
  const { discordId, username, avatarUrl } = req.body || {};

  if (!discordId || !username) {
    return res.status(400).json({ error: "discordId and username are required" });
  }

  const user = upsertUserProfile({ discordId, username, avatarUrl });
  const license = getLicenseStatus(discordId);
  const usage = getDailyUsage(discordId);

  const token = jwt.sign(
    {
      discordId: user.discord_id,
      username: user.username,
      avatarUrl: user.avatar_url,
      isAdmin: Boolean(user.is_admin)
    },
    jwtSecret,
    { expiresIn: "7d" }
  );

  return res.json({
    token,
    user: {
      discordId: user.discord_id,
      username: user.username,
      avatarUrl: user.avatar_url,
      isAdmin: Boolean(user.is_admin),
      supportUrl: supportDiscordUrl,
      license,
      usage
    }
  });
});

router.get("/me", authRequired, (req, res) => {
  const license = getLicenseStatus(req.user.discordId);
  const usage = getDailyUsage(req.user.discordId);

  return res.json({
    discordId: req.user.discordId,
    username: req.user.username,
    avatarUrl: req.user.avatarUrl,
    isAdmin: Boolean(req.user.isAdmin),
    supportUrl: supportDiscordUrl,
    license,
    usage
  });
});

module.exports = router;