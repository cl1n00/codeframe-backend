const express = require("express");
const crypto = require("crypto");
const db = require("./db");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DAILY_LIMIT = 10;
const OWNER_DISCORD_ID = String(process.env.OWNER_DISCORD_ID || "").trim();

console.log("LOADED OWNER_DISCORD_ID:", JSON.stringify(OWNER_DISCORD_ID));

app.use(express.json());

function getTodayDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

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

function getUserByDiscordId(discordId, callback) {
  db.get(
    `SELECT * FROM users WHERE discord_id = ?`,
    [discordId],
    callback
  );
}

function getDailyUsage(discordId, callback) {
  const today = getTodayDate();

  db.all(
    `SELECT config_hash FROM usage_entries WHERE discord_id = ? AND usage_date = ?`,
    [discordId, today],
    (err, rows) => {
      if (err) return callback(err);

      const hashes = rows.map((row) => row.config_hash);

      callback(null, {
        date: today,
        used: hashes.length,
        limit: DAILY_LIMIT,
        remaining: Math.max(0, DAILY_LIMIT - hashes.length),
        hashes
      });
    }
  );
}

function isLicenseValid(user) {
  if (!user) return false;
  if (!user.active) return false;
  if (!user.subscription_end) return false;
  return new Date(user.subscription_end) > new Date();
}

function getDaysRemaining(subscriptionEnd) {
  if (!subscriptionEnd) return 0;
  const now = new Date();
  const end = new Date(subscriptionEnd);
  const diff = end - now;
  if (diff <= 0) return 0;
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function adminGuard(req, res, next) {
  const adminId = String(req.headers["x-admin-id"] || "").trim();

  console.log("HEADER ADMIN ID:", JSON.stringify(adminId));
  console.log("ENV OWNER ID:", JSON.stringify(OWNER_DISCORD_ID));

  if (!OWNER_DISCORD_ID) {
    return res.status(500).json({
      error: "OWNER_DISCORD_ID is not set in .env"
    });
  }

  if (!adminId || adminId !== OWNER_DISCORD_ID) {
    return res.status(403).json({
      error: "FORBIDDEN",
      message: "Brak dostępu do panelu admina",
      debug: {
        headerAdminId: adminId || null,
        ownerDiscordId: OWNER_DISCORD_ID || null
      }
    });
  }

  next();
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    app: "CodeFrame",
    message: "Backend działa"
  });
});

app.get("/test-db", (req, res) => {
  db.all("SELECT * FROM users", [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

app.post("/auth/discord", (req, res) => {
  const { discordId, username, avatarUrl } = req.body || {};

  if (!discordId || !username) {
    return res.status(400).json({
      error: "discordId i username są wymagane"
    });
  }

  db.run(
    `
    INSERT INTO users (
      discord_id,
      username,
      avatar_url,
      plan_days,
      subscription_end,
      active
    )
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET
      username = excluded.username,
      avatar_url = excluded.avatar_url
    `,
    [discordId, username, avatarUrl || null, 0, null, 0],
    function (err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      db.get(
        `SELECT * FROM users WHERE discord_id = ?`,
        [discordId],
        (err2, row) => {
          if (err2) {
            return res.status(500).json({ error: err2.message });
          }

          res.json({
            ok: true,
            user: row,
            isAdmin: String(discordId).trim() === OWNER_DISCORD_ID
          });
        }
      );
    }
  );
});

app.get("/license/check/:discordId", (req, res) => {
  const { discordId } = req.params;

  getUserByDiscordId(discordId, (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    if (!row) {
      return res.status(404).json({
        valid: false,
        message: "Użytkownik nie istnieje"
      });
    }

    const valid = isLicenseValid(row);

    res.json({
      valid,
      discordId: row.discord_id,
      username: row.username,
      avatarUrl: row.avatar_url,
      planDays: row.plan_days,
      subscriptionEnd: row.subscription_end,
      daysRemaining: getDaysRemaining(row.subscription_end),
      active: !!row.active,
      isAdmin: String(row.discord_id).trim() === OWNER_DISCORD_ID
    });
  });
});

app.post("/admin/license/add", adminGuard, (req, res) => {
  const { discordId, days } = req.body || {};

  if (!discordId || ![3, 7, 14].includes(Number(days))) {
    return res.status(400).json({
      error: "discordId oraz days(3,7,14) są wymagane"
    });
  }

  const end = new Date();
  end.setDate(end.getDate() + Number(days));

  db.run(
    `
    UPDATE users
    SET plan_days = ?,
        subscription_end = ?,
        active = 1
    WHERE discord_id = ?
    `,
    [Number(days), end.toISOString(), discordId],
    function (err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      if (this.changes === 0) {
        return res.status(404).json({
          error: "Nie znaleziono użytkownika"
        });
      }

      db.get(
        `SELECT * FROM users WHERE discord_id = ?`,
        [discordId],
        (err2, row) => {
          if (err2) {
            return res.status(500).json({ error: err2.message });
          }

          res.json({
            ok: true,
            action: "license_added",
            user: {
              discordId: row.discord_id,
              username: row.username,
              planDays: row.plan_days,
              subscriptionEnd: row.subscription_end,
              active: !!row.active
            }
          });
        }
      );
    }
  );
});

app.post("/admin/license/remove", adminGuard, (req, res) => {
  const { discordId } = req.body || {};

  if (!discordId) {
    return res.status(400).json({
      error: "discordId jest wymagane"
    });
  }

  db.run(
    `
    UPDATE users
    SET plan_days = 0,
        subscription_end = NULL,
        active = 0
    WHERE discord_id = ?
    `,
    [discordId],
    function (err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      if (this.changes === 0) {
        return res.status(404).json({
          error: "Nie znaleziono użytkownika"
        });
      }

      res.json({
        ok: true,
        action: "license_removed",
        discordId
      });
    }
  );
});

app.get("/admin/license/status", adminGuard, (req, res) => {
  db.all(
    `
    SELECT *
    FROM users
    ORDER BY active DESC, subscription_end ASC
    `,
    [],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      const data = rows.map((row) => ({
        discordId: row.discord_id,
        username: row.username,
        avatarUrl: row.avatar_url,
        planDays: row.plan_days,
        subscriptionEnd: row.subscription_end,
        daysRemaining: getDaysRemaining(row.subscription_end),
        active: !!row.active,
        valid: isLicenseValid(row),
        isAdmin: String(row.discord_id).trim() === OWNER_DISCORD_ID
      }));

      res.json({
        ok: true,
        total: data.length,
        users: data
      });
    }
  );
});

app.get("/admin/user/:discordId", adminGuard, (req, res) => {
  const { discordId } = req.params;

  getUserByDiscordId(discordId, (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    if (!row) {
      return res.status(404).json({
        error: "Nie znaleziono użytkownika"
      });
    }

    getDailyUsage(discordId, (usageErr, usage) => {
      if (usageErr) {
        return res.status(500).json({ error: usageErr.message });
      }

      res.json({
        discordId: row.discord_id,
        username: row.username,
        avatarUrl: row.avatar_url,
        planDays: row.plan_days,
        subscriptionEnd: row.subscription_end,
        daysRemaining: getDaysRemaining(row.subscription_end),
        active: !!row.active,
        valid: isLicenseValid(row),
        usage: {
          date: usage.date,
          used: usage.used,
          remaining: usage.remaining,
          limit: usage.limit
        }
      });
    });
  });
});

app.get("/usage/status/:discordId", (req, res) => {
  const { discordId } = req.params;

  getDailyUsage(discordId, (err, usage) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    res.json(usage);
  });
});

app.post("/generate", (req, res) => {
  const {
    discordId,
    frameId,
    mode,
    iconId,
    fontId,
    text,
    color
  } = req.body || {};

  if (!discordId) {
    return res.status(400).json({ error: "discordId jest wymagane" });
  }

  if (!frameId) {
    return res.status(400).json({ error: "frameId jest wymagane" });
  }

  if (!mode || !["icon", "font"].includes(mode)) {
    return res.status(400).json({ error: "mode musi być 'icon' albo 'font'" });
  }

  if (mode === "icon" && !iconId) {
    return res.status(400).json({ error: "iconId jest wymagane dla trybu icon" });
  }

  if (mode === "font" && !fontId) {
    return res.status(400).json({ error: "fontId jest wymagane dla trybu font" });
  }

  getUserByDiscordId(discordId, (userErr, user) => {
    if (userErr) {
      return res.status(500).json({ error: userErr.message });
    }

    if (!user) {
      return res.status(404).json({ error: "Użytkownik nie istnieje" });
    }

    const valid = isLicenseValid(user);

    if (!valid) {
      return res.status(403).json({
        error: "LICENSE_EXPIRED",
        message: "Licencja wygasła. Zakup ponownie lub zamknij aplikację."
      });
    }

    const configHash = createConfigHash({
      frameId,
      mode,
      iconId,
      fontId,
      text,
      color
    });

    getDailyUsage(discordId, (usageErr, usage) => {
      if (usageErr) {
        return res.status(500).json({ error: usageErr.message });
      }

      if (usage.hashes.includes(configHash)) {
        return res.json({
          ok: true,
          counted: false,
          alreadyUsedToday: true,
          usage: {
            used: usage.used,
            remaining: usage.remaining,
            limit: DAILY_LIMIT
          },
          export: {
            format: "zip",
            files: [
              "prefix_50x8.png",
              "prefix_500x80.png",
              "prefix_1000x160.png"
            ]
          }
        });
      }

      if (usage.used >= DAILY_LIMIT) {
        return res.status(403).json({
          error: "DAILY_LIMIT_REACHED",
          message: "Dzisiejszy limit 10/10 został wykorzystany."
        });
      }

      db.run(
        `
        INSERT INTO usage_entries (discord_id, usage_date, config_hash, created_at)
        VALUES (?, ?, ?, ?)
        `,
        [discordId, usage.date, configHash, new Date().toISOString()],
        function (insertErr) {
          if (insertErr) {
            return res.status(500).json({ error: insertErr.message });
          }

          getDailyUsage(discordId, (finalErr, finalUsage) => {
            if (finalErr) {
              return res.status(500).json({ error: finalErr.message });
            }

            res.json({
              ok: true,
              counted: true,
              alreadyUsedToday: false,
              usage: {
                used: finalUsage.used,
                remaining: finalUsage.remaining,
                limit: DAILY_LIMIT
              },
              export: {
                format: "zip",
                files: [
                  "prefix_50x8.png",
                  "prefix_500x80.png",
                  "prefix_1000x160.png"
                ]
              },
              configHash
            });
          });
        }
      );
    });
  });
});

app.listen(PORT, () => {
  console.log(`CodeFrame backend listening on http://localhost:${PORT}`);
});