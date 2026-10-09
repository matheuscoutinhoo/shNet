import { SimulationEngine } from '../core/engine';
import type { Device } from '../model';
import { validateSnapshot } from '../core/validation';
import {
  remoteConfigSchema,
  remoteNetworkSchema,
  remoteRpcSchema,
  type RemoteNetwork,
  type RemoteRpc,
  type RemoteResponse,
} from './remote-model';
import { hashHex, publicKey, issueCertificate } from './security-crypto';
import { NETCONF_CAPABILITIES } from './remote-codec';
import { subnet } from './ipv4';
import { isUnicast } from './dhcp-config';
import { refreshDot1x } from './dot1x';
export function networkConfig(d: Device): RemoteNetwork {
  return remoteNetworkSchema.parse({
    hostname: d.hostname,
    routes: d.routes,
    interfaces: d.interfaces.map((p) => ({
      id: p.id,
      adminUp: p.adminUp,
      description: p.description,
      ip: p.ip,
      prefix: p.prefix,
      gateway: p.gateway,
      mode: p.mode,
      accessVlan: p.accessVlan,
      speed: p.speed,
      mtu: p.mtu,
      vrf: p.vrf,
    })),
  });
}
export const networkFingerprint = (d: Device) => hashHex(JSON.stringify(networkConfig(d)));
export function remoteConfig(d: Device) {
  if (!d.remoteManagement) throw new Error('Gerenciamento remoto não configurado.');
  const { enabled, netconf, restconf, key, clients, users, identity, trust, base11 } = d.remoteManagement;
  return { enabled, netconf, restconf, key, clients, users, identity, trust, base11 };
}
export function remoteDefaultTrust(key: string) {
  return [{ name: 'shLab management CA', publicKey: publicKey(hashHex('management CA|' + key)) }];
}
export function remoteIdentity(d: Device, key: string, clock: number) {
  const seed = hashHex('management server|' + key + '|' + d.id),
    ca = hashHex('management CA|' + key);
  return {
    seed,
    certificate: issueCertificate(ca, {
      serial: d.id,
      subject: d.hostname,
      issuer: 'shLab management CA',
      names: d.interfaces.flatMap((p) => (p.ip ? [p.ip] : [])),
      publicKey: publicKey(seed),
      usage: 'server',
      notBefore: Math.floor(clock / 1000),
      notAfter: Math.floor(clock / 1000) + 86400,
    }),
  };
}
export function configureRemote(e: SimulationEngine, d: Device, input: unknown) {
  const c = remoteConfigSchema.parse(input);
  if (
    d.type === 'pc' ||
    new Set(c.users.map((u) => u.username)).size !== c.users.length ||
    new Set(c.clients).size !== c.clients.length ||
    c.clients.some((ip) => !isUnicast(ip)) ||
    (c.enabled &&
      d.tcpServices?.some(
        (s) => s.enabled && ((c.netconf && s.port === 830) || (c.restconf && s.port === 443))
      ))
  )
    throw new Error(
      'Serviço remoto exige equipamento de rede/servidor, usuários únicos e TCP830/443 disponíveis.'
    );
  if (c.identity && publicKey(c.identity.seed) !== c.identity.certificate.publicKey)
    throw new Error('Certificado de gerenciamento não corresponde à chave privada.');
  d.remoteManagement = {
    ...c,
    identity: c.identity ?? remoteIdentity(d, c.key, e.state.clock),
    revision: 0,
    fingerprint: networkFingerprint(d),
    seen: [],
    commits: 0,
    sessions: [],
  };
  e.emit('CONFIG_CHANGED', d.id, 'NETCONF/RESTCONF educacionais configurados.');
}
function apply(e: SimulationEngine, d: Device, c: RemoteNetwork) {
  if (
    new Set(c.interfaces.map((p) => p.id)).size !== c.interfaces.length ||
    c.interfaces.length !== d.interfaces.length ||
    c.interfaces.some((p) => !d.interfaces.some((n) => n.id === p.id))
  )
    throw new Error('Interfaces do datastore não correspondem ao equipamento.');
  for (const r of c.routes)
    if (subnet(r.network, r.prefix).network !== r.network || !isUnicast(r.nextHop))
      throw new Error('Rota estática inválida/desalinhada.');
  if (new Set(c.routes.map((r) => JSON.stringify(r))).size !== c.routes.length)
    throw new Error('Rota estática duplicada.');
  d.hostname = c.hostname;
  d.routes = structuredClone(c.routes);
  for (const value of c.interfaces) {
    const p = d.interfaces.find((p) => p.id === value.id)!;
    if (p.ip !== value.ip || p.vrf !== value.vrf) {
      d.arpTable = d.arpTable.filter((a) => a.port !== p.id);
      d.pending = d.pending.filter((a) => a.port !== p.id);
      d.arpResolutions = d.arpResolutions?.filter((a) => a.port !== p.id);
      e.state.queue = e.state.queue.filter(
        (q) => q.action.kind !== 'arp-timeout' || q.action.device !== d.id || q.action.port !== p.id
      );
    }
    const oldVlan = p.accessVlan;
    Object.assign(p, value);
    for (const field of ['ip', 'prefix', 'gateway', 'vrf'] as const)
      if (value[field] === undefined) delete p[field];
    if (oldVlan !== p.accessVlan) d.macTable = d.macTable.filter((m) => m.port !== p.id);
  }
  refreshDot1x(e);
  e.refreshSpanningTree();
  e.refreshBgp();
}
function validateCandidate(e: SimulationEngine, d: Device, c: RemoteNetwork) {
  const clone = new SimulationEngine(e.snapshot());
  apply(clone, clone.device(d.id), c);
  validateSnapshot(clone.state);
}
function patchConfig(config: RemoteNetwork, rpc: RemoteRpc) {
  const c = structuredClone(config),
    patch = rpc.patch;
  if (!patch) throw new Error('edit-config/patch exige patch.');
  if (patch.hostname) c.hostname = patch.hostname;
  if (new Set(patch.interfaces.map((p) => p.id)).size !== patch.interfaces.length)
    throw new Error('Interface duplicada no patch.');
  for (const update of patch.interfaces) {
    const p = c.interfaces.find((p) => p.id === update.id);
    if (!p) throw new Error('Interface inexistente no datastore.');
    const { clearIp, ...fields } = update;
    if (clearIp && (fields.ip !== undefined || fields.prefix !== undefined))
      throw new Error('clearIp e novo endereço são incompatíveis.');
    Object.assign(p, fields);
    if (clearIp) {
      delete p.ip;
      delete p.prefix;
      delete p.gateway;
    }
  }
  const same = (a: RemoteNetwork['routes'][number], b: RemoteNetwork['routes'][number]) =>
    JSON.stringify(a) === JSON.stringify(b);
  c.routes = c.routes.filter((r) => !patch.routesRemove.some((n) => same(r, n)));
  for (const r of patch.routesAdd) if (!c.routes.some((n) => same(r, n))) c.routes.push(r);
  return remoteNetworkSchema.parse(c);
}
export function runRemoteRpc(
  e: SimulationEngine,
  d: Device,
  input: RemoteRpc,
  owner: string,
  privilege: number,
  id: string
): RemoteResponse {
  const rpc = remoteRpcSchema.parse(input),
    s = d.remoteManagement!;
  const fingerprint = networkFingerprint(d);
  if (fingerprint !== s.fingerprint) {
    s.fingerprint = fingerprint;
    s.revision++;
  }
  if (s.lock && s.lock.expiresAt <= e.state.clock) delete s.lock;
  const result = (data: unknown) => ({
    id,
    ok: true,
    code: 200,
    revision: s.revision,
    data: JSON.stringify(data),
  });
  try {
    if (rpc.operation === 'hello')
      return result({
        capabilities: NETCONF_CAPABILITIES.filter((c) => s.base11 || !c.endsWith('base:1.1')),
        encoding: 'NETCONF XML / RESTCONF YANG JSON',
      });
    if (rpc.operation === 'get' || rpc.operation === 'get-config') {
      const c =
          rpc.datastore === 'candidate'
            ? (s.candidate?.config ?? networkConfig(d))
            : rpc.datastore === 'startup'
              ? (s.startup ?? networkConfig(d))
              : networkConfig(d),
        offset = rpc.offset;
      const data = {
        datastore: rpc.datastore,
        hostname: c.hostname,
        interfaces: c.interfaces.slice(offset, offset + 8).map((p) => ({
          ...p,
          ...(rpc.operation === 'get'
            ? {
                rx: d.interfaces.find((n) => n.id === p.id)!.rx,
                tx: d.interfaces.find((n) => n.id === p.id)!.tx,
              }
            : {}),
        })),
        routes: c.routes.slice(offset, offset + 16),
        nextInterface: offset + 8 < c.interfaces.length ? offset + 8 : null,
        nextRoute: offset + 16 < c.routes.length ? offset + 16 : null,
        revision: s.revision,
      };
      if (rpc.resource?.endsWith('/hostname')) return result({ hostname: c.hostname });
      if (rpc.resource?.endsWith('/routes')) return result({ routes: data.routes });
      const port = /\/interface=([a-zA-Z0-9_-]+)$/.exec(rpc.resource ?? '')?.[1];
      if (port) {
        const found = data.interfaces.find((p) => p.id === port);
        return found
          ? result({ interfaces: [found] })
          : { id, ok: false, code: 404, revision: s.revision, error: 'Interface YANG inexistente.' };
      }
      if (rpc.resource?.endsWith('/interfaces')) return result({ interfaces: data.interfaces });
      return result(data);
    }
    if (privilege < 15)
      return { id, ok: false, code: 403, revision: s.revision, error: 'Configuração exige privilégio 15.' };
    if (s.lock && s.lock.owner !== owner)
      return {
        id,
        ok: false,
        code: 409,
        revision: s.revision,
        error: 'Datastore bloqueado por outro cliente.',
      };
    if (rpc.resource && !['get', 'get-config', 'hello'].includes(rpc.operation)) {
      const resource = rpc.resource.replace('/restconf/data/netlab:', '/restconf/data/shlab:'),
        patch = rpc.patch,
        port = /\/interface=([a-zA-Z0-9_-]+)$/.exec(resource)?.[1];
      if (rpc.operation === 'replace' && resource !== '/restconf/data/shlab:network')
        throw new Error('PUT aceita a configuração completa no recurso network.');
      if (
        rpc.operation === 'create' &&
        !resource.endsWith('/routes') &&
        resource !== '/restconf/data/shlab:network'
      )
        throw new Error('POST exige o recurso routes.');
      if (
        patch &&
        ((resource.endsWith('/hostname') &&
          (patch.interfaces.length || patch.routesAdd.length || patch.routesRemove.length)) ||
          (resource.endsWith('/routes') && (patch.hostname !== undefined || patch.interfaces.length)) ||
          (resource.includes('/interfaces') &&
            (patch.hostname !== undefined ||
              patch.routesAdd.length ||
              patch.routesRemove.length ||
              (port && patch.interfaces.some((p) => p.id !== port)))))
      )
        throw new Error('Patch ultrapassa o recurso RESTCONF selecionado.');
      if (port && !d.interfaces.some((p) => p.id === port))
        return { id, ok: false, code: 404, revision: s.revision, error: 'Interface inexistente.' };
    }
    if (rpc.ifMatch !== undefined && rpc.ifMatch !== s.revision)
      return { id, ok: false, code: 409, revision: s.revision, error: 'Revisão If-Match divergente.' };
    if (s.candidate && s.candidate.owner !== owner && !['patch', 'lock', 'unlock'].includes(rpc.operation))
      return { id, ok: false, code: 409, revision: s.revision, error: 'Candidate pertence a outro cliente.' };
    if (rpc.operation === 'lock') {
      s.lock = { owner, expiresAt: e.state.clock + 30000 };
      return result({ locked: true, leaseMs: 30000 });
    }
    if (rpc.operation === 'unlock') {
      if (!s.lock) throw new Error('Datastore não está bloqueado.');
      delete s.lock;
      return result({ locked: false });
    }
    if (rpc.operation === 'discard-changes') {
      delete s.candidate;
      return result({ discarded: true });
    }
    if (rpc.operation === 'copy-config') {
      if (!rpc.source || rpc.source === rpc.datastore)
        throw new Error('copy-config exige source diferente do target.');
      const config = structuredClone(
        rpc.source === 'candidate'
          ? (s.candidate?.config ?? networkConfig(d))
          : rpc.source === 'startup'
            ? (s.startup ?? networkConfig(d))
            : networkConfig(d)
      );
      validateCandidate(e, d, config);
      if (rpc.datastore === 'startup') s.startup = config;
      else if (rpc.datastore === 'candidate') s.candidate = { config, base: fingerprint, owner };
      else {
        apply(e, d, config);
        s.revision++;
        s.commits++;
        s.fingerprint = networkFingerprint(d);
      }
      return result({ copied: true });
    }
    if (rpc.operation === 'delete-config') {
      if (rpc.datastore !== 'startup')
        throw new Error('delete-config permitido somente no datastore startup.');
      delete s.startup;
      return result({ deleted: true });
    }
    if (rpc.operation === 'edit-config') {
      if (rpc.datastore !== 'candidate')
        throw new Error('NETCONF edit-config usa candidate; RESTCONF patch usa running.');
      const config = rpc.config ?? patchConfig(s.candidate?.config ?? networkConfig(d), rpc);
      validateCandidate(e, d, config);
      s.candidate = { config, base: s.candidate?.base ?? fingerprint, owner };
      return result({ candidate: true });
    }
    if (rpc.operation === 'validate' || rpc.operation === 'commit') {
      if (!s.candidate) throw new Error('Candidate não possui alterações.');
      if (s.candidate.base !== fingerprint)
        return {
          id,
          ok: false,
          code: 409,
          revision: s.revision,
          error: 'Running mudou após a criação do candidate.',
        };
      validateCandidate(e, d, s.candidate.config);
      if (rpc.operation === 'validate') return result({ valid: true });
      apply(e, d, s.candidate.config);
      delete s.candidate;
      s.revision++;
      s.commits++;
      s.fingerprint = networkFingerprint(d);
      e.emit('REMOTE_COMMIT', d.id, 'Candidate validado e aplicado atomicamente.');
      return result({ committed: true });
    }
    if (rpc.operation === 'delete') {
      const port = /\/interface=([a-zA-Z0-9_-]+)$/.exec(rpc.resource ?? '')?.[1];
      if (!port && !rpc.resource?.endsWith('/routes'))
        throw new Error('DELETE exige recurso interface ou routes.');
      const config = networkConfig(d);
      if (port) {
        const found = config.interfaces.find((p) => p.id === port);
        if (!found)
          return { id, ok: false, code: 404, revision: s.revision, error: 'Interface YANG inexistente.' };
        found.adminUp = false;
        delete found.ip;
        delete found.prefix;
        delete found.gateway;
        found.description = '';
      } else config.routes = [];
      validateCandidate(e, d, config);
      apply(e, d, config);
      s.revision++;
      s.commits++;
      s.fingerprint = networkFingerprint(d);
      return result({ deleted: true });
    }
    if (
      rpc.operation === 'create' &&
      (!rpc.patch?.routesAdd.length ||
        rpc.patch.routesAdd.some((r) => d.routes.some((n) => JSON.stringify(n) === JSON.stringify(r))))
    )
      return {
        id,
        ok: false,
        code: 409,
        revision: s.revision,
        error: 'POST exige novas rotas ausentes no recurso.',
      };
    const config =
      rpc.operation === 'replace'
        ? (rpc.config ??
          (() => {
            throw new Error('PUT exige configuração completa.');
          })())
        : patchConfig(networkConfig(d), rpc);
    validateCandidate(e, d, config);
    apply(e, d, config);
    s.revision++;
    s.commits++;
    s.fingerprint = networkFingerprint(d);
    e.emit('REMOTE_COMMIT', d.id, 'RESTCONF patch aplicado atomicamente.');
    return result(
      rpc.operation === 'replace'
        ? { replaced: true }
        : rpc.operation === 'create'
          ? { created: true }
          : { patched: true }
    );
  } catch (error) {
    return { id, ok: false, code: 400, revision: s.revision, error: (error as Error).message.slice(0, 500) };
  }
}
