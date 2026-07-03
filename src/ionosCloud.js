const axios = require('axios');
const net = require('net');

const BASE = 'https://api.ionos.com/cloudapi/v6';
const SSH_PROBE_PORT = 22;
const SSH_PROBE_TIMEOUT_MS = 2500;

// A quick TCP connect to port 22 -- not ICMP ping, which cloud firewalls
// routinely block regardless of whether SSH itself works. This answers the
// question that actually matters when picking a connect address: "can this
// app reach an SSH port here at all?"
function checkSshPortReachable(host) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (reachable) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(SSH_PROBE_TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(SSH_PROBE_PORT, host);
  });
}

function authHeaders(apiToken, contractNumber) {
  const headers = { Authorization: `Bearer ${apiToken}` };
  // Reseller/admin tokens can act on behalf of a specific contract via this header.
  if (contractNumber) headers['X-Contract-Number'] = String(contractNumber);
  return headers;
}

function looksLikeRhel(text) {
  return Boolean(text && /rhel|red\s*hat/i.test(text));
}

// The reliable signal is the volume's own `licenceType` field, which IONOS
// sets to the specific OS family (e.g. "RHEL", "LINUX", "WINDOWS2022") based
// on the image/snapshot used at creation time -- this works even for private
// or cross-contract images that don't resolve via the /images catalog.
// imageAlias / catalog name are kept as a fallback for older volumes.
function isRhelVolume(vol, imageMap) {
  const props = (vol && vol.properties) || {};
  if ((props.licenceType || '').toUpperCase() === 'RHEL') return true;
  if (looksLikeRhel(props.imageAlias)) return true;
  const catalogEntry = props.image ? imageMap.get(props.image) : null;
  if (catalogEntry && (looksLikeRhel(catalogEntry.name) || (catalogEntry.licenceType || '').toUpperCase() === 'RHEL')) return true;
  return false;
}

function volumeLabel(vol, imageMap) {
  const props = (vol && vol.properties) || {};
  const catalogEntry = props.image ? imageMap.get(props.image) : null;
  return props.imageAlias || (catalogEntry && catalogEntry.name) || props.licenceType || 'RHEL';
}

async function fetchImageCatalog(headers) {
  const map = new Map();
  try {
    const resp = await axios.get(`${BASE}/images`, { headers, params: { depth: 1 }, timeout: 30000 });
    for (const img of resp.data.items || []) {
      map.set(img.id, { name: img.properties && img.properties.name, licenceType: img.properties && img.properties.licenceType });
    }
  } catch (err) {
    // Non-fatal -- we can still detect RHEL via imageAlias without the catalog.
  }
  return map;
}

// Searches every datacenter visible to this token (optionally scoped to a
// contract via X-Contract-Number) for servers whose boot image looks like
// RHEL, via either the image alias (e.g. "rhel:9") used at creation time or
// the resolved image's name from the public/private image catalog.
async function discoverRhelServers({ apiToken, contractNumber }) {
  if (!apiToken) {
    throw new Error('IONOS Cloud API token is required');
  }
  const headers = authHeaders(apiToken, contractNumber);

  const [dcResp, imageMap] = await Promise.all([
    axios.get(`${BASE}/datacenters`, { headers, params: { depth: 1 }, timeout: 30000 }),
    fetchImageCatalog(headers),
  ]);

  const datacenters = dcResp.data.items || [];
  const results = [];

  for (const dc of datacenters) {
    let srvResp;
    try {
      // eslint-disable-next-line no-await-in-loop
      srvResp = await axios.get(`${BASE}/datacenters/${dc.id}/servers`, {
        headers,
        params: { depth: 5 },
        timeout: 60000,
      });
    } catch (err) {
      // eslint-disable-next-line no-continue
      continue;
    }

    for (const server of srvResp.data.items || []) {
      const volumes = (server.entities && server.entities.volumes && server.entities.volumes.items) || [];
      const rhelVolume = volumes.find((vol) => isRhelVolume(vol, imageMap));

      if (!rhelVolume) continue;
      const matchedImageLabel = volumeLabel(rhelVolume, imageMap);

      const nics = (server.entities && server.entities.nics && server.entities.nics.items) || [];
      const ips = nics.flatMap((n) => (n.properties && n.properties.ips) || []);

      results.push({
        id: server.id,
        name: (server.properties && server.properties.name) || server.id,
        datacenterId: dc.id,
        datacenterName: (dc.properties && dc.properties.name) || dc.id,
        image: matchedImageLabel,
        ips,
      });
    }
  }

  const uniqueIps = [...new Set(results.flatMap((r) => r.ips))];
  const reachabilityEntries = await Promise.all(
    uniqueIps.map(async (ip) => [ip, await checkSshPortReachable(ip)])
  );
  const reachabilityMap = new Map(reachabilityEntries);

  for (const server of results) {
    server.ipStatus = server.ips.map((ip) => ({ address: ip, sshReachable: reachabilityMap.get(ip) }));
  }

  return results;
}

module.exports = { discoverRhelServers };
