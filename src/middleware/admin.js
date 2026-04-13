function adminRequired(req, res, next) {
  if (!req.user?.isAdmin) {
    return res.status(403).json({ error: "FORBIDDEN" });
  }
  return next();
}

module.exports = { adminRequired };