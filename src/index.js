const express = require("express");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const db = require("./db");
const dotenv = require("dotenv");
const cors = require("cors");

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DAILY_LIMIT = 10;
const OWNER_DISCORD_ID = String(process.env.OWNER_DISCORD_ID || "").trim();

const JWT_SECRET = process.env.JWT_SECRET || "change-me";
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || "";
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const CODE_LOGIN_EXPIRES_MINUTES = Number(process.env.CODE_LOGIN_EXPIRES_MINUTES || 5);
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const SUPPORT_DISCORD_URL = process.env.SUPPORT_DISCORD_URL || "";

console.log("LOADED OWNER_DISCORD_ID:", JSON.stringify(OWNER_DISCORD_ID));
console.log("DISCORD_REDIRECT_URI:", DISCORD_REDIRECT_URI);
console.log("FRONTEND_URL:", FRONTEND_URL);
console.log("BOT TOKEN LOADED:", !!DISCORD_BOT_TOKEN);

app.use(express.json());
app.use(
  cors({
    origin: (origin, callback) => {
      const allowedOrigins = [
        "http://localhost:5173",
        FRONTEND_URL,
      ].filter(Boolean);

      if (!origin || origin === "null") {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      console.warn("CORS blocked for origin:", origin);
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: false,
  })
);

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
    color: color || "",
  });

  return crypto.createHash("sha256").update(raw).digest("hex");
}

function hashLoginCode(discordId, code) {
  return crypto
    .createHash("sha256")
    .update(`${discordId}:${code}:${JWT_SECRET}`)
    .digest("hex");
}

function generateLoginCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function isDiscordId(value) {
  return /^\d{17,20}$/.test(String(value || "").trim());
}

function getUserByDiscordId(discordId, callback) {
  db.get(`SELECT * FROM users WHERE discord_id = ?`, [discordId], callback);
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
        hashes,
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
      error: "OWNER_DISCORD_ID is not set in .env",
    });
  }

  if (!adminId || adminId !== OWNER_DISCORD_ID) {
    return res.status(403).json({
      error: "FORBIDDEN",
      message: "Brak dostępu do panelu admina",
      debug: {
        headerAdminId: adminId || null,
        ownerDiscordId: OWNER_DISCORD_ID || null,
      },
    });
  }

  next();
}

async function discordApi(path, options = {}) {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    ...options,
    headers: {
      "Authorization": `Bot ${DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const message =
      data?.message ||
      `Discord API error ${res.status}`;
    throw new Error(message);
  }

  return data;
}

async function fetchDiscordUserByBot(discordId) {
  if (!DISCORD_BOT_TOKEN) {
    throw new Error("DISCORD_BOT_TOKEN is not set");
  }

  const data = await discordApi(`/users/${discordId}`, {
    method: "GET",
  });

  const avatarUrl = data.avatar
    ? `https://cdn.discordapp.com/avatars/${data.id}/${data.avatar}.png`
    : null;

  return {
    discordId: data.id,
    username: data.global_name || data.username,
    avatarUrl,
  };
}

async function sendDiscordDmCode(discordId, code) {
  if (!DISCORD_BOT_TOKEN) {
    throw new Error("DISCORD_BOT_TOKEN is not set");
  }

  const dmChannel = await discordApi(`/users/@me/channels`, {
    method: "POST",
    body: JSON.stringify({
      recipient_id: discordId,
    }),
  });

  await discordApi(`/channels/${dmChannel.id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content:
        `Twój kod logowania do CodeFrame: **${code}**\n` +
        `Kod wygasa za ${CODE_LOGIN_EXPIRES_MINUTES} minut.\n` +
        `Jeśli to nie Ty, zignoruj tę wiadomość.`,
    }),
  });
}

function upsertUserFromDiscordProfile(profile, callback) {
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
    [profile.discordId, profile.username, profile.avatarUrl, 0, null, 0],
    callback
  );
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    app: "CodeFrame",
    message: "Backend działa",
  });
});

app.get("/debug/ping", (req, res) => {
  res.json({
    ok: true,
    ts: Date.now(),
    frontendUrl: FRONTEND_URL,
    redirectUri: DISCORD_REDIRECT_URI,
    clientIdLoaded: !!DISCORD_CLIENT_ID,
    secretLoaded: !!DISCORD_CLIENT_SECRET,
    botTokenLoaded: !!DISCORD_BOT_TOKEN,
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

/**
 * NOWE LOGOWANIE KODEM DM
 */
app.post("/auth/request-code", async (req, res) => {
  try {
    const discordId = String(req.body?.discordId || "").trim();

    if (!isDiscordId(discordId)) {
      return res.status(400).json({
        error: "INVALID_DISCORD_ID",
        message: "Podaj poprawne Discord ID.",
      });
    }

    if (!DISCORD_BOT_TOKEN) {
      return res.status(500).json({
        error: "BOT_TOKEN_MISSING",
        message: "Brak DISCORD_BOT_TOKEN w backendzie.",
      });
    }

    const code = generateLoginCode();
    const codeHash = hashLoginCode(discordId, code);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CODE_LOGIN_EXPIRES_MINUTES * 60 * 1000);

    db.run(
      `UPDATE login_codes SET used = 1 WHERE discord_id = ? AND used = 0`,
      [discordId],
      async (markErr) => {
        if (markErr) {
          return res.status(500).json({ error: markErr.message });
        }

        db.run(
          `
          INSERT INTO login_codes (discord_id, code_hash, expires_at, used, created_at)
          VALUES (?, ?, ?, 0, ?)
          `,
          [discordId, codeHash, expiresAt.toISOString(), now.toISOString()],
          async (insertErr) => {
            if (insertErr) {
              return res.status(500).json({ error: insertErr.message });
            }

            try {
              await sendDiscordDmCode(discordId, code);

              return res.json({
                ok: true,
                message: "Kod został wysłany na PW Discorda.",
                expiresInMinutes: CODE_LOGIN_EXPIRES_MINUTES,
              });
            } catch (dmError) {
              console.error("SEND DM ERROR:", dmError);

              return res.status(400).json({
                error: "DM_SEND_FAILED",
                message:
                  "Nie udało się wysłać wiadomości prywatnej. Upewnij się, że bot może do Ciebie pisać i jesteś na wspólnym serwerze.",
              });
            }
          }
        );
      }
    );
  } catch (error) {
    console.error("REQUEST CODE ERROR:", error);
    return res.status(500).json({
      error: "REQUEST_CODE_ERROR",
      message: error.message,
    });
  }
});

app.post("/auth/verify-code", async (req, res) => {
  try {
    const discordId = String(req.body?.discordId || "").trim();
    const code = String(req.body?.code || "").trim();

    if (!isDiscordId(discordId)) {
      return res.status(400).json({
        error: "INVALID_DISCORD_ID",
        message: "Podaj poprawne Discord ID.",
      });
    }

    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({
        error: "INVALID_CODE",
        message: "Kod musi mieć 6 cyfr.",
      });
    }

    const codeHash = hashLoginCode(discordId, code);

    db.get(
      `
      SELECT *
      FROM login_codes
      WHERE discord_id = ?
        AND code_hash = ?
        AND used = 0
      ORDER BY id DESC
      LIMIT 1
      `,
      [discordId, codeHash],
      async (err, row) => {
        if (err) {
          return res.status(500).json({ error: err.message });
        }

        if (!row) {
          return res.status(401).json({
            error: "CODE_NOT_FOUND",
            message: "Nieprawidłowy kod.",
          });
        }

        if (new Date(row.expires_at) <= new Date()) {
          return res.status(401).json({
            error: "CODE_EXPIRED",
            message: "Kod wygasł. Wygeneruj nowy.",
          });
        }

        let profile;
        try {
          profile = await fetchDiscordUserByBot(discordId);
        } catch (profileError) {
          console.error("FETCH DISCORD USER ERROR:", profileError);
          return res.status(500).json({
            error: "DISCORD_FETCH_FAILED",
            message: "Nie udało się pobrać danych użytkownika z Discorda.",
          });
        }

        upsertUserFromDiscordProfile(profile, (upsertErr) => {
          if (upsertErr) {
            return res.status(500).json({ error: upsertErr.message });
          }

          db.run(
            `UPDATE login_codes SET used = 1 WHERE id = ?`,
            [row.id],
            (usedErr) => {
              if (usedErr) {
                return res.status(500).json({ error: usedErr.message });
              }

              const appToken = jwt.sign(
                {
                  discordId: profile.discordId,
                  username: profile.username,
                  avatarUrl: profile.avatarUrl,
                  isAdmin: String(profile.discordId).trim() === OWNER_DISCORD_ID,
                },
                JWT_SECRET,
                { expiresIn: "7d" }
              );

              return res.json({
                ok: true,
                token: appToken,
                user: {
                  discordId: profile.discordId,
                  username: profile.username,
                  avatarUrl: profile.avatarUrl,
                },
              });
            }
          );
        });
      }
    );
  } catch (error) {
    console.error("VERIFY CODE ERROR:", error);
    return res.status(500).json({
      error: "VERIFY_CODE_ERROR",
      message: error.message,
    });
  }
});

/**
 * STARE OAUTH - możesz zostawić albo później wywalić
 */
app.get("/auth/discord/start", (req, res) => {
  if (!DISCORD_CLIENT_ID || !DISCORD_REDIRECT_URI) {
    return res.status(500).json({
      error: "DISCORD_OAUTH_NOT_CONFIGURED",
    });
  }

  const isDesktop = String(req.query.desktop || "") === "1";
  console.log("DISCORD START DESKTOP PARAM:", req.query.desktop);
  console.log("DISCORD START IS DESKTOP:", isDesktop);

  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", DISCORD_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", DISCORD_REDIRECT_URI);
  url.searchParams.set("scope", "identify");

  if (isDesktop) {
    url.searchParams.set("state", "desktop");
  }

  console.log("DISCORD START REDIRECT URL:", url.toString());
  return res.redirect(url.toString());
});

app.get("/auth/discord/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    console.log("DISCORD CALLBACK RAW QUERY:", req.query);
    console.log("DISCORD CALLBACK STATE:", state);

    if (!code) {
      return res.status(400).json({ error: "CODE_MISSING" });
    }

    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: DISCORD_REDIRECT_URI,
      }).toString(),
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.access_token) {
      console.error("DISCORD TOKEN ERROR:", tokenData);
      return res.status(400).json({
        error: "DISCORD_TOKEN_ERROR",
        details: tokenData,
      });
    }

    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
      },
    });

    const discordUser = await userRes.json();

    if (!userRes.ok || !discordUser.id) {
      console.error("DISCORD USER ERROR:", discordUser);
      return res.status(400).json({
        error: "DISCORD_USER_ERROR",
        details: discordUser,
      });
    }

    const avatarUrl = discordUser.avatar
      ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
      : null;

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
      [discordUser.id, discordUser.username, avatarUrl, 0, null, 0],
      function (err) {
        if (err) {
          return res.status(500).json({ error: err.message });
        }

        const appToken = jwt.sign(
          {
            discordId: discordUser.id,
            username: discordUser.username,
            avatarUrl,
            isAdmin: String(discordUser.id).trim() === OWNER_DISCORD_ID,
          },
          JWT_SECRET,
          { expiresIn: "7d" }
        );

        const isDesktop = String(state || "").trim() === "desktop";
        console.log("DISCORD CALLBACK IS DESKTOP:", isDesktop);

        if (isDesktop) {
          const redirectUrl = `codeframe://auth?token=${encodeURIComponent(appToken)}`;
          console.log("DISCORD CALLBACK REDIRECT ->", redirectUrl);
          return res.redirect(redirectUrl);
        }

        const redirectUrl = `${FRONTEND_URL}?token=${encodeURIComponent(appToken)}`;
        console.log("DISCORD CALLBACK REDIRECT ->", redirectUrl);
        return res.redirect(redirectUrl);
      }
    );
  } catch (error) {
    console.error("DISCORD CALLBACK ERROR:", error);
    return res.status(500).json({
      error: "DISCORD_CALLBACK_ERROR",
      message: error.message,
    });
  }
});

app.get("/auth/me", (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    db.get(
      `SELECT * FROM users WHERE discord_id = ?`,
      [decoded.discordId],
      (err, row) => {
        if (err) {
          return res.status(500).json({ error: err.message });
        }

        if (!row) {
          return res.status(404).json({ error: "USER_NOT_FOUND" });
        }

        return res.json({
          discordId: row.discord_id,
          username: row.username,
          avatarUrl: row.avatar_url,
          planDays: row.plan_days,
          subscriptionEnd: row.subscription_end,
          daysRemaining: getDaysRemaining(row.subscription_end),
          active: !!row.active,
          valid: isLicenseValid(row),
          isAdmin: String(row.discord_id).trim() === OWNER_DISCORD_ID,
          supportUrl: SUPPORT_DISCORD_URL,
        });
      }
    );
  } catch (error) {
    return res.status(401).json({
      error: "INVALID_TOKEN",
      message: error.message,
    });
  }
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
        message: "Użytkownik nie istnieje",
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
      isAdmin: String(row.discord_id).trim() === OWNER_DISCORD_ID,
    });
  });
});

app.post("/admin/license/add", adminGuard, (req, res) => {
  const { discordId, days, username, avatarUrl } = req.body || {};

  if (!discordId || ![3, 7, 14].includes(Number(days))) {
    return res.status(400).json({
      error: "discordId oraz days(3,7,14) są wymagane",
    });
  }

  const end = new Date();
  end.setDate(end.getDate() + Number(days));

  db.get(
    `SELECT * FROM users WHERE discord_id = ?`,
    [discordId],
    (checkErr, existingUser) => {
      if (checkErr) {
        return res.status(500).json({ error: checkErr.message });
      }

      const upsertAndActivate = () => {
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
                    active: !!row.active,
                  },
                });
              }
            );
          }
        );
      };

      if (!existingUser) {
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
          `,
          [discordId, username || "UnknownUser", avatarUrl || null, 0, null, 0],
          function (insertErr) {
            if (insertErr) {
              return res.status(500).json({ error: insertErr.message });
            }

            upsertAndActivate();
          }
        );
      } else {
        upsertAndActivate();
      }
    }
  );
});

app.post("/admin/license/remove", adminGuard, (req, res) => {
  const { discordId } = req.body || {};

  if (!discordId) {
    return res.status(400).json({
      error: "discordId jest wymagane",
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
          error: "Nie znaleziono użytkownika",
        });
      }

      res.json({
        ok: true,
        action: "license_removed",
        discordId,
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
        isAdmin: String(row.discord_id).trim() === OWNER_DISCORD_ID,
      }));

      res.json({
        ok: true,
        total: data.length,
        users: data,
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
        error: "Nie znaleziono użytkownika",
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
          limit: usage.limit,
        },
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
  const { discordId, frameId, mode, iconId, fontId, text, color } = req.body || {};

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
        message: "Licencja wygasła. Zakup ponownie lub zamknij aplikację.",
      });
    }

    const configHash = createConfigHash({
      frameId,
      mode,
      iconId,
      fontId,
      text,
      color,
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
            limit: DAILY_LIMIT,
          },
          export: {
            format: "zip",
            files: ["prefix_50x8.png", "prefix_500x80.png", "prefix_1000x160.png"],
          },
        });
      }

      if (usage.used >= DAILY_LIMIT) {
        return res.status(403).json({
          error: "DAILY_LIMIT_REACHED",
          message: "Dzisiejszy limit 10/10 został wykorzystany.",
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
                limit: DAILY_LIMIT,
              },
              export: {
                format: "zip",
                files: ["prefix_50x8.png", "prefix_500x80.png", "prefix_1000x160.png"],
              },
              configHash,
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