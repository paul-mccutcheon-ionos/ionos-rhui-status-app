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

function isPrivateIp(ip) {
  return /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(ip || '');
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

// NAT gateways, NLBs, and ALBs are fetched once per datacenter (not per
// server) since they're datacenter-wide resources that any number of
// discovered servers may share. Each fetch is independently non-fatal --
// a token/contract without one of these features (or without permission to
// list it) shouldn't stop RHEL server discovery from working.
async function fetchDcNetworkContext(headers, dcId) {
  const get = async (path, depth) => {
    try {
      const resp = await axios.get(`${BASE}/datacenters/${dcId}/${path}`, { headers, params: { depth }, timeout: 30000 });
      return resp.data.items || [];
    } catch (err) {
      return [];
    }
  };
  const [natGateways, nlbs, albs, targetGroups] = await Promise.all([
    get('natgateways', 3),
    get('networkloadbalancers', 3), // depth=3 embeds entities.forwardingrules.items (targets are inline properties)
    get('applicationloadbalancers', 3),
    get('targetgroups', 3), // ALB forwarding rules reference these by id, not embedded
  ]);
  return { natGateways, nlbs, albs, targetGroups };
}

// A NAT gateway provides the outbound internet path a private host needs to
// reach the RHUI server at all -- if none is attached to the host's LAN(s),
// outbound traffic (and therefore RHUI) cannot work regardless of anything
// else being configured correctly.
function matchNatGateway(natGateways, lanIds) {
  const gw = natGateways.find((g) =>
    ((g.properties && g.properties.lans) || []).some((l) => lanIds.includes(l.id))
  );
  if (!gw) return null;
  return { id: gw.id, name: gw.properties.name, publicIps: gw.properties.publicIps || [] };
}

// Finds NLB/ALB forwarding rules whose target matches one of this server's
// private IPs -- i.e. a public entry point that reaches this host. No port
// filter is applied here (the target port may or may not be SSH's port);
// the caller/UI decides what to do with each match's targetPort.
function matchSshEntryPoints(nlbs, albs, targetGroups, privateIps) {
  const points = [];
  const tgById = new Map(targetGroups.map((tg) => [tg.id, tg]));

  for (const nlb of nlbs) {
    const rules = (nlb.entities && nlb.entities.forwardingrules && nlb.entities.forwardingrules.items) || [];
    for (const rule of rules) {
      for (const target of (rule.properties && rule.properties.targets) || []) {
        if (privateIps.includes(target.ip)) {
          points.push({
            type: 'NLB',
            name: nlb.properties.name,
            id: nlb.id,
            externalIps: nlb.properties.ips || [],
            externalPort: rule.properties.listenerPort,
            targetIp: target.ip,
            targetPort: target.port,
            protocol: rule.properties.protocol,
          });
        }
      }
    }
  }

  for (const alb of albs) {
    const rules = (alb.entities && alb.entities.forwardingrules && alb.entities.forwardingrules.items) || [];
    for (const rule of rules) {
      for (const httpRule of (rule.properties && rule.properties.httpRules) || []) {
        const tg = httpRule.targetGroup && tgById.get(httpRule.targetGroup);
        if (!tg) continue;
        for (const target of (tg.properties && tg.properties.targets) || []) {
          if (privateIps.includes(target.ip)) {
            points.push({
              type: 'ALB',
              name: alb.properties.name,
              id: alb.id,
              externalIps: alb.properties.ips || [],
              externalPort: rule.properties.listenerPort,
              targetIp: target.ip,
              targetPort: target.port,
              protocol: rule.properties.protocol,
            });
          }
        }
      }
    }
  }
  return points;
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
    let dcContext;
    try {
      // eslint-disable-next-line no-await-in-loop
      [srvResp, dcContext] = await Promise.all([
        axios.get(`${BASE}/datacenters/${dc.id}/servers`, {
          headers,
          params: { depth: 5 },
          timeout: 60000,
        }),
        fetchDcNetworkContext(headers, dc.id),
      ]);
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
      const lanIds = [...new Set(nics.map((n) => n.properties && n.properties.lan).filter((v) => v != null))];
      const privateIps = ips.filter(isPrivateIp);
      const hasPrivateIp = privateIps.length > 0;

      results.push({
        id: server.id,
        name: (server.properties && server.properties.name) || server.id,
        datacenterId: dc.id,
        datacenterName: (dc.properties && dc.properties.name) || dc.id,
        image: matchedImageLabel,
        ips,
        hasPrivateIp,
        natGateway: hasPrivateIp ? matchNatGateway(dcContext.natGateways, lanIds) : null,
        sshEntryPoints: hasPrivateIp
          ? matchSshEntryPoints(dcContext.nlbs, dcContext.albs, dcContext.targetGroups, privateIps)
          : [],
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

    // If nothing answers directly on SSH but a load balancer forwards to this
    // host, suggest its public endpoint as the connect address instead of a
    // private IP the app has no route to.
    const directlyReachable = server.ipStatus.some((s) => s.sshReachable);
    const entry = server.sshEntryPoints[0];
    server.suggestedConnectAddress =
      !directlyReachable && entry && entry.externalIps[0] ? `${entry.externalIps[0]}:${entry.externalPort}` : null;
  }

  return results;
}

module.exports = { discoverRhelServers };
