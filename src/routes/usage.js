const express = require("express");
const { authRequired } = require("../middleware/auth");
const { getDailyUsage } = require("../services/usageService");

const router = express.Router();

router.get("/status", authRequired, (req, res) => {
  return res.json(getDailyUsage(req.user.discordId));
});

module.exports = router;