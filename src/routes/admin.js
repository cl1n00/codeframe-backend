const express = require("express");
const { authRequired } = require("../middleware/auth");
const { adminRequired } = require("../middleware/admin");
const {
  activateLicense,
  revokeLicense,
  listActiveLicenses,
  getUserByDiscordId
} = require("../services/licenseService");

const router = express.Router();

router.use(authRequired, adminRequired);

router.get("/licenses", (req, res) => {
  return res.json(listActiveLicenses());
});

router.post("/licenses/add", (req, res) => {
  try {
    const { discordId, days } = req.body || {};

    if (!discordId || ![3, 7, 14].includes(Number(days))) {
      return res.status(400).json({ error: "discordId and days(3,7,14) are required" });
    }

    const user = getUserByDiscordId(discordId);
    if (!user) {
      return res.status(404).json({ error: "USER_NOT_FOUND" });
    }

    const result = activateLicense({
      discordId,
      days: Number(days),
      adminId: req.user.discordId
    });

    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message || "INTERNAL_ERROR" });
  }
});

router.post("/licenses/remove", (req, res) => {
  try {
    const { discordId } = req.body || {};

    if (!discordId) {
      return res.status(400).json({ error: "discordId is required" });
    }

    const result = revokeLicense(discordId);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message || "INTERNAL_ERROR" });
  }
});

module.exports = router;