const crypto = require("crypto");
const db = require("../db");
const { dateOnly } = require("./licenseService");

const DAILY_LIMIT = 10;

function createConfigHash({ frameId, mode, iconId, fontId, text, color }) {
  const raw = JSON.stringify({
    frameId: frameId || null,
    mode: mode || null,
    iconId: iconId || null,
    fontId: fontId || null,
    text: text || "",
    color: color || ""
  });

  return crypto.createHash("sha256").update(raw).digest("hex");
}

function getDailyUsage(discordId, usageDate = dateOnly()) {
  const rows = db.prepare(`
    SELECT config_hash
    FROM usage_entries
    WHERE discord_id = ?
      AND usage_date = ?
  `).all(discordId, usageDate);

  return {
    date: usageDate,
    used: rows.length,
    limit: DAILY_LIMIT,
    remaining: Math.max(0, DAILY_LIMIT - rows.length),
    hashes: rows.map((r) => r.config_hash)
  };
}

function consumeIfNewConfig(discordId, configHash, usageDate = dateOnly()) {
  const usage = getDailyUsage(discordId, usageDate);

  if (usage.hashes.includes(configHash)) {
    return {
      counted: false,
      alreadyUsedToday: true,
      used: usage.used,
      remaining: usage.remaining
    };
  }

  if (usage.used >= DAILY_LIMIT) {
    return {
      counted: false,
      limitReached: true,
      used: usage.used,
      remaining: 0
    };
  }

  db.prepare(`
    INSERT INTO usage_entries (discord_id, usage_date, config_hash, created_at)
    VALUES (?, ?, ?, ?)
  `).run(discordId, usageDate, configHash, new Date().toISOString());

  const nextUsage = getDailyUsage(discordId, usageDate);

  return {
    counted: true,
    alreadyUsedToday: false,
    limitReached: false,
    used: nextUsage.used,
    remaining: nextUsage.remaining
  };
}

module.exports = {
  DAILY_LIMIT,
  createConfigHash,
  getDailyUsage,
  consumeIfNewConfig
};