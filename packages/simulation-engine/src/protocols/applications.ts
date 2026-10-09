import type { SimulationEngine } from '../core/engine';
import type { Action, Device, Snapshot, TcpConnection } from '../model';
import {
  brokerConfigSchema,
  printerConfigSchema,
  proxyConfigSchema,
  mqttMessageSchema,
} from './applications-model';
import { configureTcpService, queueTcpText } from './tcp-services';
import { closeTcp, flushTcp, openTcp } from './tcp';
import { tcpBytes, tcpFinished } from './tcp-model';
import {
  proxyRequest,
  proxyResponse,
  printerRequest,
  respondHttp,
  startProxyUpstream,
} from './applications-http';
import { encodeMqtt, decodeMqtt, mqttMatches, validMqttFilter } from './mqtt-codec';
import type { z } from 'zod';
import { isUnicast } from './dhcp-config';
import { unicast6, linkLocal6, normalize6 } from './ipv6-address';
type Service = Extract<Action, { kind: 'application-tick' }>['service'];
function schedule(e: SimulationEngine, d: Device, service: Service) {
  const state = d[service];
  if (!state) return;
  e.state.queue = e.state.queue.filter(
    (q) => q.action.kind !== 'application-tick' || q.action.device !== d.id || q.action.service !== service
  );
  state.nextAt = e.state.clock + 1000;
  e.schedule(1000, { kind: 'application-tick', device: d.id, service, token: state.token });
}
function checkPort(d: Device, port: number, kind: string, old?: number, oldKind = kind) {
  if (d.tcpServices?.some((s) => s.enabled && s.port === port && !(s.kind === oldKind && s.port === old)))
    throw new Error('Porta ocupada por outro serviço TCP.');
}
export function configureProxy(e: SimulationEngine, d: Device, input: unknown) {
  const c = proxyConfigSchema.parse(input);
  checkPort(d, c.port, c.kind, d.proxy?.port, d.proxy?.kind);
  const unicast = (address: string) =>
    address.includes(':')
      ? unicast6(address) && !linkLocal6(address) && normalize6(address) !== '::1'
      : isUnicast(address);
  if (!c.backends.every((b) => unicast(b.address)) || !c.allowedNetworks.every(unicast))
    throw new Error('Backends e destinos permitidos exigem endereço unicast de rede.');
  c.backends = c.backends.map((b) => ({
    ...b,
    address: b.address.includes(':') ? normalize6(b.address) : b.address,
  }));
  c.allowedNetworks = c.allowedNetworks.map((address) =>
    address.includes(':') ? normalize6(address) : address
  );
  if (new Set(c.allowedNetworks).size !== c.allowedNetworks.length)
    throw new Error('Destino permitido duplicado.');
  if (c.kind === 'load-balancer' && c.enabled && !c.backends.length)
    throw new Error('Balanceador requer backends.');
  if (new Set(c.backends.map((b) => b.address + ':' + b.port)).size !== c.backends.length)
    throw new Error('Backend duplicado.');
  if (
    c.backends.some(
      (b) =>
        d.interfaces.some((p) => p.ip === b.address || p.ipv6?.addresses.some((a) => a.ip === b.address)) &&
        b.port === c.port
    )
  )
    throw new Error('Backend aponta para o próprio balanceador.');
  configureTcpService(e, d, { port: c.port, kind: c.kind, enabled: c.enabled });
  if (d.proxy && d.proxy.port !== c.port)
    d.tcpServices = d.tcpServices?.filter((s) => s.port !== d.proxy!.port);
  for (const r of d.proxy?.requests.filter((r) => r.state === 'pending') ?? [])
    closeTcp(e, d, r.upstream, true);
  d.proxy = {
    ...c,
    cursor: 0,
    health: c.backends.map((b) => ({ ...b, state: 'unknown', checkedAt: e.state.clock })),
    requests: [],
    token: e.id('proxy'),
    nextAt: e.state.clock + 1000,
  };
  schedule(e, d, 'proxy');
}
export function configurePrinter(e: SimulationEngine, d: Device, input: unknown) {
  const c = printerConfigSchema.parse(input);
  checkPort(d, c.port, 'ipp', d.printer?.port);
  configureTcpService(e, d, { port: c.port, kind: 'ipp', enabled: c.enabled });
  if (d.printer && d.printer.port !== c.port)
    d.tcpServices = d.tcpServices?.filter((s) => s.port !== d.printer!.port);
  d.printer = {
    ...c,
    sequence: d.printer?.sequence ?? 0,
    jobs: d.printer?.jobs ?? [],
    token: e.id('printer'),
    nextAt: e.state.clock + 1000,
  };
  schedule(e, d, 'printer');
}
export function configureBroker(e: SimulationEngine, d: Device, input: unknown) {
  const c = brokerConfigSchema.parse(input);
  checkPort(d, c.port, 'mqtt', d.broker?.port);
  configureTcpService(e, d, { port: c.port, kind: 'mqtt', enabled: c.enabled });
  if (d.broker && d.broker.port !== c.port)
    d.tcpServices = d.tcpServices?.filter((s) => s.port !== d.broker!.port);
  for (const client of d.broker?.clients ?? []) closeTcp(e, d, client.connection, true);
  d.broker = {
    ...c,
    clients: [],
    retained: d.broker?.retained ?? [],
    token: e.id('broker'),
    nextAt: e.state.clock + 1000,
  };
  schedule(e, d, 'broker');
}
function mqttSend(e: SimulationEngine, d: Device, c: TcpConnection, m: z.infer<typeof mqttMessageSchema>) {
  queueTcpText(c, encodeMqtt(m));
  flushTcp(e, d, c);
}
export function connectIot(
  e: SimulationEngine,
  d: Device,
  broker: string,
  clientId = d.hostname,
  port = 1883,
  keepAlive = 30
) {
  mqttMessageSchema.parse({ type: 'CONNECT', clientId, keepAlive });
  const previous = d.tcpConnections?.find((c) => c.id === d.iot?.connection);
  if (previous && !tcpFinished(previous)) closeTcp(e, d, previous.id, true);
  return openTcp(e, d, broker, port, encodeMqtt({ type: 'CONNECT', clientId, keepAlive }), false, (c) => {
    c.service = 'mqtt';
    c.stream = { readBytes: 0, writtenBytes: 0 };
    d.iot = {
      connection: c.id,
      broker,
      port,
      clientId,
      state: 'CONNECTING',
      subscriptions: [],
      readings: [],
      keepAlive,
      lastAt: e.state.clock,
      pingPending: false,
      token: e.id('iot'),
      nextAt: e.state.clock + 1000,
    };
    schedule(e, d, 'iot');
  });
}
export function publishIot(e: SimulationEngine, d: Device, topic: string, payload: string, retain = false) {
  if (!d.iot || d.iot.state !== 'CONNECTED') throw new Error('Conecte o IoT ao broker MQTT.');
  if (!topic || /[+#\0]/.test(topic)) throw new Error('PUBLISH não aceita wildcards.');
  const m = mqttMessageSchema.parse({ type: 'PUBLISH', topic, payload, retain });
  mqttSend(
    e,
    d,
    d.tcpConnections!.find((c) => c.id === d.iot!.connection)!,
    m
  );
  d.iot.lastAt = e.state.clock;
}
export function subscribeIot(e: SimulationEngine, d: Device, topic: string) {
  if (
    !d.iot ||
    d.iot.state !== 'CONNECTED' ||
    !validMqttFilter(topic) ||
    topic.length > 128 ||
    d.iot.subscriptions.length >= 32
  )
    throw new Error('MQTT: conexão, filtro ou limite inválido.');
  mqttSend(
    e,
    d,
    d.tcpConnections!.find((c) => c.id === d.iot!.connection)!,
    { type: 'SUBSCRIBE', topic, id: 1 + (e.state.sequence % 65535) }
  );
  if (!d.iot.subscriptions.includes(topic)) d.iot.subscriptions.push(topic);
  d.iot.lastAt = e.state.clock;
}
function mqttReceive(e: SimulationEngine, d: Device, c: TcpConnection) {
  for (let count = 0; c.received.includes('\n') && count < 64; count++) {
    const at = c.received.indexOf('\n'),
      line = c.received.slice(0, at),
      consumed = at + 1;
    c.received = c.received.slice(consumed);
    c.bytesReceived = tcpBytes(c.received);
    c.stream!.readBytes += consumed;
    const m = decodeMqtt(line);
    if (c.role === 'client') {
      const iot = d.iot;
      if (!iot || iot.connection !== c.id) throw new Error('MQTT cliente sem sessão.');
      iot.lastAt = e.state.clock;
      iot.pingPending = false;
      if (m.type === 'CONNACK') {
        iot.state = m.code === 0 ? 'CONNECTED' : 'DISCONNECTED';
        if (m.code) c.closeRequested = true;
      } else if (m.type === 'PUBLISH' && iot.state === 'CONNECTED') {
        iot.readings.push({ topic: m.topic, payload: m.payload, at: e.state.clock });
        if (iot.readings.length > 256) iot.readings.shift();
        e.emit('APPLICATION_DATA', d.id, `MQTT ${m.topic}: ${m.payload.slice(0, 180)}`);
      } else if (!['SUBACK', 'PINGRESP'].includes(m.type))
        throw new Error('MQTT mensagem incompatível com cliente.');
      continue;
    }
    const broker = d.broker;
    if (!broker?.enabled) throw new Error('Broker desligado.');
    let client = broker.clients.find((s) => s.connection === c.id);
    if (m.type === 'CONNECT' && !client) {
      const duplicate = broker.clients.find((s) => s.clientId === m.clientId);
      if (duplicate) {
        closeTcp(e, d, duplicate.connection, true);
        broker.clients = broker.clients.filter((s) => s !== duplicate);
      }
      if (broker.clients.length >= 128) {
        mqttSend(e, d, c, { type: 'CONNACK', code: 3 });
        c.closeRequested = true;
        continue;
      }
      client = {
        connection: c.id,
        clientId: m.clientId,
        subscriptions: [],
        keepAlive: m.keepAlive,
        lastAt: e.state.clock,
      };
      broker.clients.push(client);
      mqttSend(e, d, c, { type: 'CONNACK', code: 0 });
      continue;
    }
    if (!client) throw new Error('MQTT exige CONNECT antes de dados.');
    client.lastAt = e.state.clock;
    if (m.type === 'SUBSCRIBE') {
      if (!validMqttFilter(m.topic) || client.subscriptions.length >= 32)
        throw new Error('MQTT filtro/limite inválido.');
      if (!client.subscriptions.includes(m.topic)) client.subscriptions.push(m.topic);
      mqttSend(e, d, c, { type: 'SUBACK', id: m.id });
      for (const r of broker.retained.filter((r) => mqttMatches(m.topic, r.topic)))
        mqttSend(e, d, c, { type: 'PUBLISH', ...r, retain: true });
    } else if (m.type === 'PUBLISH') {
      if (/[+#\0]/.test(m.topic)) throw new Error('MQTT tópico inválido.');
      if (m.retain) {
        broker.retained = broker.retained.filter((r) => r.topic !== m.topic);
        if (m.payload) {
          if (broker.retained.length >= 128) throw new Error('MQTT limite de retained.');
          broker.retained.push({ topic: m.topic, payload: m.payload });
        }
      }
      for (const subscriber of broker.clients.filter((s) =>
        s.subscriptions.some((f) => mqttMatches(f, m.topic))
      )) {
        const target = d.tcpConnections?.find((t) => t.id === subscriber.connection);
        if (target && !tcpFinished(target)) mqttSend(e, d, target, { ...m, retain: false });
      }
    } else if (m.type === 'PINGREQ') mqttSend(e, d, c, { type: 'PINGRESP' });
    else if (m.type === 'DISCONNECT') {
      client.lastAt = 0;
      broker.clients = broker.clients.filter((s) => s !== client);
      c.closeRequested = true;
    } else throw new Error('MQTT mensagem incompatível com broker.');
  }
}
export function receiveSpecialApplication(e: SimulationEngine, d: Device, c: TcpConnection) {
  if (!['proxy', 'load-balancer', 'proxy-upstream', 'ipp', 'mqtt'].includes(c.service)) return false;
  try {
    if (c.service === 'proxy-upstream') proxyResponse(e, d, c);
    else if (c.service === 'mqtt') mqttReceive(e, d, c);
    else if (c.role === 'server' && c.service === 'ipp') printerRequest(e, d, c);
    else if (c.role === 'server') proxyRequest(e, d, c);
  } catch (error) {
    e.drop(d, 'Aplicação: ' + (error instanceof Error ? error.message : 'dados inválidos'));
    closeTcp(e, d, c.id, true);
  }
  return true;
}
export function handleApplicationTick(e: SimulationEngine, a: Extract<Action, { kind: 'application-tick' }>) {
  const d = e.device(a.device),
    state = d[a.service];
  if (!state || state.token !== a.token) return;
  if (d.power) {
    if (a.service === 'proxy' && d.proxy?.enabled) {
      for (const r of d.proxy.requests.filter((r) => r.state === 'pending')) {
        const c = d.tcpConnections?.find((c) => c.id === r.upstream);
        if (r.deadline <= e.state.clock || !c || tcpFinished(c)) {
          r.state = 'failed';
          const h = d.proxy.health.find((h) => h.address === r.backend && h.port === r.port);
          if (h) {
            h.state = 'down';
            h.checkedAt = e.state.clock;
            delete h.connection;
          }
          const front = d.tcpConnections?.find((c) => c.id === r.front);
          if (front && !tcpFinished(front))
            respondHttp(e, d, front, '502 Bad Gateway', 'Backend não respondeu dentro do prazo.');
          if (c && !tcpFinished(c)) closeTcp(e, d, c.id, true);
        }
      }
      if (d.proxy.kind === 'load-balancer')
        for (const h of d.proxy.health)
          if (!h.connection && e.state.clock - h.checkedAt >= d.proxy.healthIntervalMs)
            startProxyUpstream(e, d, h.address, h.port);
    } else if (a.service === 'printer' && d.printer?.enabled) {
      const p = d.printer,
        job = p.jobs.find((j) => ['pending', 'processing', 'stopped'].includes(j.state));
      if (job && job.nextPage <= e.state.clock) {
        if (!p.paper) job.state = 'stopped';
        else {
          job.state = 'processing';
          job.printed++;
          p.paper--;
          job.nextPage = e.state.clock + 60000 / p.pagesPerMinute;
          if (job.printed === job.pages) {
            job.state = 'completed';
            e.emit('APPLICATION_DATA', d.id, `IPP Job ${job.id} concluído.`);
          }
        }
      }
    } else if (a.service === 'broker' && d.broker) {
      for (const client of [...d.broker.clients])
        if (
          e.state.clock - client.lastAt > client.keepAlive * 1500 ||
          !d.tcpConnections?.some((c) => c.id === client.connection && !tcpFinished(c))
        ) {
          if (d.tcpConnections?.some((c) => c.id === client.connection))
            closeTcp(e, d, client.connection, true);
          d.broker.clients = d.broker.clients.filter((c) => c !== client);
        }
    } else if (a.service === 'iot' && d.iot) {
      const iot = d.iot,
        c = d.tcpConnections?.find((c) => c.id === iot.connection);
      if (!c || tcpFinished(c)) iot.state = 'DISCONNECTED';
      else if (iot.state === 'CONNECTED' && e.state.clock - iot.lastAt >= iot.keepAlive * 1000) {
        if (iot.pingPending) {
          iot.state = 'DISCONNECTED';
          closeTcp(e, d, c.id, true);
        } else {
          mqttSend(e, d, c, { type: 'PINGREQ' });
          iot.pingPending = true;
          iot.lastAt = e.state.clock;
        }
      }
    }
  }
  schedule(e, d, a.service);
}
export function validateApplications(s: Snapshot) {
  const used = new Set<object>();
  for (const d of s.devices)
    for (const service of ['proxy', 'printer', 'broker', 'iot'] as const) {
      const state = d[service];
      if (!state) continue;
      const q = s.queue.filter(
        (q) =>
          q.action.kind === 'application-tick' && q.action.device === d.id && q.action.service === service
      );
      if (
        q.length !== 1 ||
        q[0].at !== state.nextAt ||
        q[0].action.kind !== 'application-tick' ||
        q[0].action.token !== state.token
      )
        throw new Error('Serviço sem timer correspondente.');
      used.add(q[0].action);
      if (
        service !== 'iot' &&
        !d.tcpServices?.some(
          (c) => c.port === state.port && c.enabled === ('enabled' in state && state.enabled)
        )
      )
        throw new Error('Serviço sem listener TCP.');
      if (service === 'proxy' && d.proxy)
        for (const r of d.proxy.requests) {
          if (
            r.state === 'pending' &&
            (!d.tcpConnections?.some((c) => c.id === r.upstream && c.service === 'proxy-upstream') ||
              (r.front &&
                !d.tcpConnections?.some(
                  (c) => c.id === r.front && ['proxy', 'load-balancer'].includes(c.service)
                )))
          )
            throw new Error('Proxy sem conexões correspondentes.');
        }
      if (service === 'printer' && d.printer) {
        const ids = new Set<number>();
        for (const j of d.printer.jobs) {
          if (
            ids.has(j.id) ||
            j.id > d.printer.sequence ||
            j.printed > j.pages ||
            (j.state === 'completed' && j.printed !== j.pages)
          )
            throw new Error('Spool IPP inválido.');
          ids.add(j.id);
        }
      }
      if (service === 'broker' && d.broker) {
        if (
          new Set(d.broker.clients.map((c) => c.clientId)).size !== d.broker.clients.length ||
          new Set(d.broker.retained.map((c) => c.topic)).size !== d.broker.retained.length
        )
          throw new Error('MQTT estado duplicado.');
        for (const client of d.broker.clients)
          if (
            !d.tcpConnections?.some(
              (c) => c.id === client.connection && c.role === 'server' && c.service === 'mqtt'
            ) ||
            client.lastAt > s.clock ||
            !client.subscriptions.every(validMqttFilter)
          )
            throw new Error('Sessão MQTT inválida.');
      }
      if (
        service === 'iot' &&
        d.iot &&
        !d.tcpConnections?.some(
          (c) =>
            c.id === d.iot!.connection &&
            c.service === 'mqtt' &&
            c.role === 'client' &&
            c.remoteIp === d.iot!.broker &&
            c.remotePort === d.iot!.port
        )
      )
        throw new Error('IoT sem conexão MQTT.');
    }
  for (const q of s.queue)
    if (q.action.kind === 'application-tick' && !used.has(q.action))
      throw new Error('Timer de aplicação órfão.');
}
