const express = require('express');
const config = require('../config');
const rhuiChecks = require('../rhuiChecks');

const router = express.Router();

let cachedStatus = null;
let lastCheckAt = null;
let checkInFlight = null;

async function refreshStatus() {
  if (checkInFlight) return checkInFlight;
  checkInFlight = rhuiChecks
    .checkAll(config.getConfig())
    .then((result) => {
      cachedStatus = result;
      lastCheckAt = Date.now();
      return result;
    })
    .finally(() => {
      checkInFlight = null;
    });
  return checkInFlight;
}

router.get('/config/status', (req, res) => {
  res.json({ configured: config.isConfigured() });
});

router.get('/config', (req, res) => {
  const cfg = config.getConfig();
  const redact = (h) => ({
    label: h.label,
    host: h.host,
    port: h.port,
    username: h.username,
    keyPath: h.keyPath,
    hasKeyContent: Boolean(h.keyContent),
    hasPassphrase: Boolean(h.passphrase),
  });
  res.json({
    hosts: { rhel8: redact(cfg.hosts.rhel8), rhel9: redact(cfg.hosts.rhel9) },
    services: cfg.services,
    dataPath: cfg.dataPath,
    certPath: cfg.certPath,
    clientTlsPort: cfg.clientTlsPort,
    monitoredRepos: cfg.monitoredRepos,
    pollIntervalSeconds: cfg.pollIntervalSeconds,
  });
});

router.post('/config', (req, res) => {
  const body = req.body || {};
  const overrides = {};

  for (const prefix of ['RHEL8', 'RHEL9']) {
    const key = prefix.toLowerCase();
    const h = body[key] || {};
    if (h.label !== undefined) overrides[`${prefix}_LABEL`] = h.label;
    if (h.host !== undefined) overrides[`${prefix}_HOST`] = h.host;
    if (h.port !== undefined) overrides[`${prefix}_SSH_PORT`] = String(h.port);
    if (h.username !== undefined) overrides[`${prefix}_SSH_USER`] = h.username;
    if (h.keyPath !== undefined) overrides[`${prefix}_SSH_KEY_PATH`] = h.keyPath;
    if (h.keyContent !== undefined) overrides[`${prefix}_SSH_KEY_CONTENT`] = h.keyContent;
    if (h.passphrase !== undefined) overrides[`${prefix}_SSH_PASSPHRASE`] = h.passphrase;
  }

  if (body.services !== undefined) overrides.RHUI_SERVICES = body.services;
  if (body.dataPath !== undefined) overrides.RHUI_DATA_PATH = body.dataPath;
  if (body.certPath !== undefined) overrides.RHUI_ENTITLEMENT_CERT_PATH = body.certPath;
  if (body.clientTlsPort !== undefined) overrides.RHUI_CLIENT_TLS_PORT = String(body.clientTlsPort);
  if (body.monitoredRepos !== undefined) overrides.RHUI_MONITORED_REPOS = body.monitoredRepos;

  config.setOverrides(overrides);
  cachedStatus = null;
  res.json({ ok: true, configured: config.isConfigured() });
});

router.post('/config/save', (req, res) => {
  try {
    const envPath = config.saveOverridesToEnvFile();
    res.json({ ok: true, savedTo: envPath });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/status', async (req, res) => {
  if (!config.isConfigured()) {
    res.status(409).json({ error: 'Not configured. Submit configuration via POST /api/config first.' });
    return;
  }

  const force = req.query.refresh === 'true';
  const stale = !lastCheckAt || Date.now() - lastCheckAt > config.getConfig().pollIntervalSeconds * 1000;

  try {
    if (force || stale || !cachedStatus) {
      await refreshStatus();
    }
    res.json(cachedStatus);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
