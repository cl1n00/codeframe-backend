const express = require("express");
const { authRequired } = require("../middleware/auth");
const { getLicenseStatus } = require("../services/licenseService");

const router = express.Router();

router.get("/check", authRequired, (req, res) => {
  const status = getLicenseStatus(req.user.discordId);
  return res.json(status);
});

module.exports = router;