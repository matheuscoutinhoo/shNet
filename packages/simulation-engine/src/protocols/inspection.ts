import type { SimulationEngine } from '../core/engine';
import type { Device, Packet, NetworkInterface, Snapshot } from '../model';
import { inspectionConfigSchema, type InspectionFlow } from './inspection-model';
import { tcpAdd, tcpBytes, tcpDistance } from './tcp-model';
export function configureInspection(e: SimulationEngine, d: Device, input: unknown) {
  if (!d.firewall) throw new Error('Configure o firewall antes da inspeção de aplicação.');
  const c = inspectionConfigSchema.parse(input);
  c.flows = [];
  for (const r of c.rules) r.hits = 0;
  validateRules(c);
  d.firewall.application = c;
  e.state.queue = e.state.queue.filter(
    (q) => q.action.kind !== 'inspection-expire' || q.action.device !== d.id
  );
  e.emit('CONFIG_CHANGED', d.id, 'Inspeção de HTTP/DNS configurada; classificação reiniciada.');
}
export function validateRules(c: NonNullable<NonNullable<Device['firewall']>['application']>) {
  if (
    new Set(c.rules.map((r) => r.sequence)).size !== c.rules.length ||
    c.rules.some((r) =>
      r.application === 'http'
        ? r.nameSuffix !== undefined
        : r.host !== undefined || r.pathPrefix !== undefined
    )
  )
    throw new Error('Regra de aplicação inválida/duplicada: HTTP usa host/pathPrefix; DNS usa nameSuffix.');
  c.rules.sort((a, b) => a.sequence - b.sequence);
}
function event(e: SimulationEngine, d: Device, application: string, decision: string, rule?: number) {
  e.emit(
    'FIREWALL_APPLICATION',
    d.id,
    application + ': ' + decision + (rule ? ' pela regra ' + rule : ' pela ação padrão') + '.'
  );
}
function touch(e: SimulationEngine, d: Device, f: InspectionFlow) {
  e.state.queue = e.state.queue.filter(
    (q) => q.action.kind !== 'inspection-expire' || q.action.device !== d.id || q.action.flow !== f.id
  );
  f.expiresAt = e.state.clock + 120000;
  e.schedule(120000, { kind: 'inspection-expire', device: d.id, flow: f.id, at: f.expiresAt });
}
export function expireInspection(e: SimulationEngine, d: Device, id: string, at: number) {
  const c = d.firewall?.application;
  if (c) c.flows = c.flows.filter((f) => f.id !== id || f.expiresAt !== at);
}
export function inspectApplication(
  e: SimulationEngine,
  d: Device,
  input: NetworkInterface,
  output: NetworkInterface,
  packet: Packet
) {
  const c = d.firewall?.application;
  if (!c?.enabled) return true;
  const deny = (reason: string) => {
    d.firewall!.dropped++;
    e.emit('FIREWALL_DENY', d.id, reason, { port: input.id });
    e.drop(d, reason, input.id);
    return false;
  };
  if (packet.protocol === 'UDP') {
    if (packet.payload.protocol !== 'DNS' || packet.payload.message.type !== 'query') return true;
    const name = packet.payload.message.question.name;
    const r = c.rules.find(
      (r) =>
        r.application === 'dns' &&
        (!r.destinationPort || r.destinationPort === packet.destinationPort) &&
        (!r.nameSuffix || name === r.nameSuffix || name.endsWith('.' + r.nameSuffix))
    );
    if (r) r.hits++;
    const action = r?.action ?? c.defaultAction;
    event(e, d, 'DNS ' + name, action, r?.sequence);
    return action === 'permit' || deny('Inspeção DNS: consulta bloqueada para ' + name + '.');
  }
  if (packet.protocol !== 'TCP') return true;
  const forward = (f: InspectionFlow) =>
    f.clientIp === packet.src &&
    f.serverIp === packet.dst &&
    f.clientPort === packet.sourcePort &&
    f.serverPort === packet.destinationPort &&
    f.input === input.id &&
    f.output === output.id;
  const reverse = (f: InspectionFlow) =>
    f.serverIp === packet.src &&
    f.clientIp === packet.dst &&
    f.serverPort === packet.sourcePort &&
    f.clientPort === packet.destinationPort &&
    f.output === input.id &&
    f.input === output.id;
  let f = c.flows.find((f) => forward(f) || reverse(f));
  if (f?.decision === 'deny') return deny('Inspeção de aplicação: fluxo bloqueado.');
  if (!packet.data || (f && reverse(f))) return true;
  if (!f) {
    if (c.flows.length >= 1024) return deny('Limite de fluxos para inspeção de aplicação.');
    const session = d.firewall!.sessions.find(
      (s) =>
        s.protocol === 'TCP' &&
        s.clientIp === packet.src &&
        s.serverIp === packet.dst &&
        s.clientPort === packet.sourcePort &&
        s.serverPort === packet.destinationPort
    );
    f = {
      id: e.id('inspection'),
      clientIp: packet.src,
      serverIp: packet.dst,
      clientPort: packet.sourcePort,
      serverPort: packet.destinationPort,
      input: input.id,
      output: output.id,
      nextSequence: session?.protocol === 'TCP' ? tcpAdd(session.clientInitial, 1) : packet.sequence,
      buffer: '',
      application: 'pending',
      decision: 'pending',
      expiresAt: 0,
    };
    c.flows.push(f);
  }
  touch(e, d, f);
  if (f.decision === 'permit') return true;
  if (packet.sequence !== f.nextSequence) {
    const end = tcpAdd(packet.sequence, tcpBytes(packet.data));
    if (tcpDistance(end, f.nextSequence) < 65536 && tcpDistance(packet.sequence, f.nextSequence) < 65536)
      return true;
    const ahead = tcpDistance(f.nextSequence, packet.sequence),
      segments = (f.pendingSegments ??= []);
    const same = segments.find((s) => s.sequence === packet.sequence && s.data === packet.data);
    if (same) return true;
    if (
      ahead <= 8192 &&
      ahead + tcpBytes(packet.data) <= 8192 &&
      segments.length < 32 &&
      !segments.some((s) => {
        const at = tcpDistance(f!.nextSequence, s.sequence);
        return at < ahead + tcpBytes(packet.data) && ahead < at + tcpBytes(s.data);
      })
    ) {
      segments.push({ sequence: packet.sequence, data: packet.data });
      return true;
    }
    f.application = 'unknown';
    f.decision = 'deny';
    f.buffer = '';
    f.pendingSegments = [];
    return deny('Inspeção: intervalo ambíguo ou buffer de reordenação excedido.');
  }
  f.nextSequence = tcpAdd(packet.sequence, tcpBytes(packet.data));
  f.buffer = (f.buffer + packet.data).slice(0, 8192);
  while (f.pendingSegments?.some((s) => s.sequence === f!.nextSequence)) {
    const index = f.pendingSegments.findIndex((s) => s.sequence === f!.nextSequence),
      segment = f.pendingSegments.splice(index, 1)[0];
    f.nextSequence = tcpAdd(f.nextSequence, tcpBytes(segment.data));
    f.buffer = (f.buffer + segment.data).slice(0, 8192);
  }
  const methods = ['GET ', 'POST ', 'PUT ', 'DELETE ', 'HEAD ', 'OPTIONS ', 'PATCH ', 'CONNECT ', 'TRACE '];
  const plausible = methods.some((m) => m.startsWith(f!.buffer) || f!.buffer.startsWith(m));
  const complete = f.buffer.includes('\r\n\r\n');
  if (plausible && !complete && f.buffer.length < 8192) return true;
  const line = /^(\S+) (\/\S*) HTTP\/1\.[01]\r\n/.exec(f.buffer),
    host = /\r\nHost:\s*([^\r\n]+)/i.exec(f.buffer)?.[1].trim().toLowerCase().replace(/:\d+$/, '');
  f.application = line && complete ? 'http' : 'unknown';
  if (f.application === 'http') {
    f.path = line![2];
    if (host && /^[a-z0-9.-]{1,253}$/.test(host)) f.host = host;
  }
  const r =
    f.application === 'http'
      ? c.rules.find(
          (r) =>
            r.application === 'http' &&
            (!r.destinationPort || r.destinationPort === f!.serverPort) &&
            (!r.host || r.host === f!.host) &&
            (!r.pathPrefix || f!.path!.startsWith(r.pathPrefix))
        )
      : undefined;
  if (r) r.hits++;
  f.rule = r?.sequence;
  f.decision = r?.action ?? c.defaultAction;
  // Store only headers needed for classification. Subsequent bodies are never accumulated.
  f.buffer = '';
  f.pendingSegments = [];
  event(e, d, f.application + (f.host ? ' ' + f.host : ''), f.decision, f.rule);
  return f.decision === 'permit' || deny('Inspeção ' + f.application + ': pedido bloqueado.');
}
export function validateInspection(s: Snapshot) {
  const timers = s.queue.filter((q) => q.action.kind === 'inspection-expire');
  for (const d of s.devices) {
    const c = d.firewall?.application;
    if (!c) continue;
    validateRules(c);
    if (
      new Set(c.flows.map((f) => f.id)).size !== c.flows.length ||
      new Set(
        c.flows.map((f) =>
          JSON.stringify([f.clientIp, f.serverIp, f.clientPort, f.serverPort, f.input, f.output])
        )
      ).size !== c.flows.length
    )
      throw new Error('Fluxo de inspeção duplicado.');
    for (const f of c.flows) {
      const ts = timers.filter(
        (t) => t.action.kind === 'inspection-expire' && t.action.device === d.id && t.action.flow === f.id
      );
      if (
        !c.enabled ||
        !d.firewall?.enabled ||
        !d.interfaces.some((p) => p.id === f.input && p.mode === 'routed') ||
        !d.interfaces.some((p) => p.id === f.output && p.mode === 'routed') ||
        f.expiresAt < s.clock ||
        (f.rule &&
          !c.rules.some(
            (r) => r.sequence === f.rule && r.application === 'http' && r.action === f.decision
          )) ||
        (f.application === 'pending') !== (f.decision === 'pending') ||
        (f.application !== 'pending' && f.buffer !== '') ||
        (f.application !== 'pending' && !!f.pendingSegments?.length) ||
        !!f.pendingSegments?.some((segment, index, all) => {
          const at = tcpDistance(f.nextSequence, segment.sequence);
          return (
            at > 8192 ||
            at + tcpBytes(segment.data) > 8192 ||
            all.some((other, i) => {
              const pos = tcpDistance(f.nextSequence, other.sequence);
              return i !== index && pos < at + tcpBytes(segment.data) && at < pos + tcpBytes(other.data);
            })
          );
        }) ||
        ts.length !== 1 ||
        ts[0].at !== f.expiresAt ||
        ts[0].action.kind !== 'inspection-expire' ||
        ts[0].action.at !== f.expiresAt
      )
        throw new Error('Estado/timer da inspeção de aplicação inválido.');
    }
  }
  for (const t of timers) {
    const a = t.action;
    if (
      a.kind === 'inspection-expire' &&
      !s.devices.find((d) => d.id === a.device)?.firewall?.application?.flows.some((f) => f.id === a.flow)
    )
      throw new Error('Timer de inspeção órfão.');
  }
}
