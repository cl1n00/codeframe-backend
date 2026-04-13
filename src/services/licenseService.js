const db = require("../db");
const { ownerDiscordId } = require("../config");

function nowIso() {
  return new Date().toISOString();
}

function dateOnly(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function addDays(startDate, days) {
  const d = new Date(startDate);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

function getUserByDiscordId(discordId) {
  const stmt = db.prepare(`
    SELECT *
    FROM users
    WHERE discord_id = ?
  `);
  return stmt.get(discordId) || null;
}

function upsertUserProfile({ discordId, username, avatarUrl }) {
  const existing = getUserByDiscordId(discordId);
  const now = nowIso();
  const isAdmin = discordId === ownerDiscordId ? 1 : 0;

  if (!existing) {
    db.prepare(`
      INSERT INTO users (
        discord_id, username, avatar_url, plan_days, subscription_start,
        subscription_end, active, is_admin, created_at, updated_at
      ) VALUES (?, ?, ?, 0, NULL, NULL, 0, ?, ?, ?)
    `).run(discordId, username, avatarUrl || null, isAdmin, now, now);
  } else {
    db.prepare(`
      UPDATE users
      SET username = ?,
          avatar_url = ?,
          is_admin = ?,
          updated_at = ?
      WHERE discord_id = ?
    `).run(username, avatarUrl || null, isAdmin, now, discordId);
  }

  return getUserByDiscordId(discordId);
}

function activateLicense({ discordId, days, adminId }) {
  const user = getUserByDiscordId(discordId);
  if (!user) {
    throw new Error("USER_NOT_FOUND");
  }

  const now = new Date();
  const start = nowIso();
  const end = addDays(now, Number(days));

  db.prepare(`
    UPDATE users
    SET plan_days = ?,
        subscription_start = ?,
        subscription_end = ?,
        active = 1,
        updated_at = ?
    WHERE discord_id = ?
  `).run(Number(days), start, end, nowIso(), discordId);

  return {
    ok: true,
    adminId,
    discordId,
    planDays: Number(days),
    subscriptionStart: start,
    subscriptionEnd: end
  };
}

function revokeLicense(discordId) {
  const user = getUserByDiscordId(discordId);
  if (!user) {
    throw new Error("USER_NOT_FOUND");
  }

  db.prepare(`
    UPDATE users
    SET active = 0,
        updated_at = ?
    WHERE discord_id = ?
  `).run(nowIso(), discordId);

  return { ok: true, discordId };
}

function getDaysRemaining(subscriptionEnd) {
  if (!subscriptionEnd) return 0;
  const end = new Date(subscriptionEnd).getTime();
  const now = Date.now();
  const diff = end - now;
  if (diff <= 0) return 0;
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function isLicenseValid(user) {
  if (!user) return false;
  if (!user.active) return false;
  if (!user.subscription_end) return false;
  return new Date(user.subscription_end).getTime() > Date.now();
}

function getLicenseStatus(discordId) {
  const user = getUserByDiscordId(discordId);
  if (!user) {
    return {
      exists: false,
      valid: false
    };
  }

  const valid = isLicenseValid(user);
  const daysRemaining = getDaysRemaining(user.subscription_end);

  return {
    exists: true,
    valid,
    discordId: user.discord_id,
    username: user.username,
    avatarUrl: user.avatar_url,
    isAdmin: Boolean(user.is_admin),
    planDays: user.plan_days,
    subscriptionStart: user.subscription_start,
    subscriptionEnd: user.subscription_end,
    daysRemaining,
    active: Boolean(user.active)
  };
}

function listActiveLicenses() {
  const rows = db.prepare(`
    SELECT *
    FROM users
    WHERE active = 1
    ORDER BY subscription_end ASC
  `).all();

  return rows.map((row) => ({
    discordId: row.discord_id,
    username: row.username,
    avatarUrl: row.avatar_url,
    planDays: row.plan_days,
    subscriptionStart: row.subscription_start,
    subscriptionEnd: row.subscription_end,
    daysRemaining: getDaysRemaining(row.subscription_end),
    valid: isLicenseValid(row),
    isAdmin: Boolean(row.is_admin)
  }));
}

module.exports = {
  dateOnly,
  getUserByDiscordId,
  upsertUserProfile,
  activateLicense,
  revokeLicense,
  getLicenseStatus,
  listActiveLicenses,
  isLicenseValid
};