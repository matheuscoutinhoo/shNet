import { describe, expect, it } from 'vitest';
import { SimulationEngine, makeTemplate, wirelessConfig, type NetworkEvent } from '@shlab/engine';
import {
  CANVAS_ACTIVITY_LIMITS,
  collectCanvasActivities,
  emptyCanvasActivities,
  eventTone,
  newCanvasEvents,
  pruneCanvasActivities,
} from '../apps/web/src/workspace/canvasActivity';

function lan() {
  const engine = new SimulationEngine(makeTemplate('lan'));
  const clients = engine.state.devices.filter((device) => device.type === 'pc');
  const cursor = engine.state.events.at(-1)?.id;
  const probe = engine.ping(clients[0].id, clients[1].interfaces[0].ip!);
  for (
    let step = 0;
    step < 100 && engine.state.probes.find((entry) => entry.id === probe)?.status === 'pending';
    step++
  )
    engine.step();
  return { engine, events: newCanvasEvents(engine.state.events, cursor) };
}

describe('atividade visual vinculada ao motor de rede', () => {
  it('classifica DHCPv6 e relay emitidos como controle e distingue RAW/DNS IPv6', () => {
    const engine = new SimulationEngine();
    const client = engine.addDevice('pc'),
      relay = engine.addDevice('router'),
      server = engine.addDevice('server');
    engine.connect({ device: client.id, port: 'p0' }, { device: relay.id, port: 'p0' });
    engine.connect({ device: relay.id, port: 'p1' }, { device: server.id, port: 'p0' });
    relay.ipv6Routing = true;
    for (const [device, port, ip] of [
      [relay, 'p0', '2001:db8:1::1'],
      [relay, 'p1', '2001:db8:2::1'],
      [server, 'p0', '2001:db8:2::10'],
    ] as const)
      engine.configureIpv6(device.id, port, { auto: false, addresses: [{ ip, prefix: 64 }] });
    engine.configureIpv6(client.id, 'p0', { auto: false, addresses: [] });
    engine.configureDhcp6Relay(relay.id, 'p0', { enabled: true, servers: ['2001:db8:2::10'] });
    engine.configureDhcp6Server(server.id, {
      enabled: true,
      relayPeers: ['2001:db8:2::1'],
      pools: [
        {
          name: 'RELAY',
          port: 'p0',
          relayLink: { network: '2001:db8:1::', prefix: 64 },
          addresses: { start: '2001:db8:1::100', end: '2001:db8:1::110' },
          validMs: 60000,
          preferredMs: 45000,
          t1Ms: 20000,
          t2Ms: 40000,
          dns: ['2001:db8:2::10'],
        },
      ],
    });
    engine.advanceTo(6000);
    engine.configureDhcp6Client(client.id, 'p0', {
      enabled: true,
      requestAddress: true,
      requestPrefix: false,
    });
    engine.advanceTo(12000);
    expect(client.interfaces[0].dhcp6?.state).toBe('BOUND');
    engine.configureUdp6Service(server.id, { kind: 'echo', port: 7, enabled: true });
    engine.sendUdp6(relay.id, '2001:db8:2::10', 7, 'Datagrama IPv6');
    engine.configureDnsRecord(server.id, {
      name: 'visual.lab',
      type: 'AAAA',
      value: '2001:db8:2::10',
      ttl: 60,
    });
    engine.setDnsEnabled(server.id, true);
    engine.lookupDns(relay.id, 'visual.lab', 'AAAA', '2001:db8:2::10');
    engine.advanceTo(12500);
    const frames = engine.state.events.filter(
      (event) => event.type === 'FRAME_SENT' && event.frame?.ipv6?.protocol === 'UDP'
    );
    const protocols = new Set<string>();
    for (const event of frames) {
      const packet = event.frame!.ipv6!;
      if (packet.protocol !== 'UDP') throw new Error('Fixture UDP IPv6 inválida');
      const protocol = packet.datagram.payload.protocol;
      protocols.add(protocol);
      expect(eventTone(event)).toBe(['DHCPv6', 'DHCPv6-RELAY'].includes(protocol) ? 'control' : 'traffic');
      if (protocol === 'RAW') {
        const reservedPorts = {
          ...event,
          frame: {
            ...event.frame!,
            ipv6: { ...packet, datagram: { ...packet.datagram, sourcePort: 546, destinationPort: 547 } },
          },
        };
        expect(eventTone(reservedPorts)).toBe('traffic');
      }
    }
    expect(protocols).toEqual(new Set(['DHCPv6', 'DHCPv6-RELAY', 'RAW', 'DNS']));
    expect(relay.dnsQueries?.at(-1)?.status).toBe('success');
  });

  it('distingue gestão CAPWAP tipada no canal 5246 de dados HTTP no canal 5247', () => {
    const engine = new SimulationEngine();
    const wlc = engine.addDevice('switch', { x: 400, y: 300 }),
      ap = engine.addDevice('switch', { x: 80, y: 80 }),
      client = engine.addDevice('pc', { x: 85, y: 85 }),
      server = engine.addDevice('server');
    Object.assign(wlc.interfaces[0], { mode: 'routed', ip: '192.0.2.1', prefix: 24 });
    Object.assign(ap.interfaces[0], { mode: 'routed', ip: '192.0.2.2', prefix: 24 });
    wlc.vlans.push({ id: 10, name: 'WLAN' });
    wlc.interfaces[1].accessVlan = 10;
    Object.assign(server.interfaces[0], { ip: '10.0.0.20', prefix: 24 });
    engine.connect({ device: wlc.id, port: 'p0' }, { device: ap.id, port: 'p0' });
    engine.connect({ device: server.id, port: 'p0' }, { device: wlc.id, port: 'p1' });
    const profile = {
      ...wirelessConfig(ap),
      role: 'ap' as const,
      ssid: 'shLab',
      security: 'wpa2-psk' as const,
      key: 'wireless-campus-key',
      noise: -110,
    };
    engine.configureWireless(ap.id, profile);
    engine.configureWireless(client.id, { ...profile, role: 'client' });
    Object.assign(
      client.interfaces.find((port) => port.id === 'wlan0')!,
      { ip: '10.0.0.10', prefix: 24 }
    );
    engine.configureWlc(wlc.id, {
      enabled: true,
      underlay: 'p0',
      key: 'controller-network-key',
      allowedWtps: [ap.id],
      profiles: [{ name: 'campus', vlan: 10, wireless: profile }],
    });
    engine.configureWtp(ap.id, {
      enabled: true,
      underlay: 'p0',
      controller: '192.0.2.1',
      key: 'controller-network-key',
      profile: 'campus',
    });
    engine.configureTcpService(server.id, { kind: 'http', enabled: true, port: 80, body: 'CAPWAP HTTP' });
    engine.advanceTo(7000);
    engine.httpGet(client.id, '10.0.0.20');
    engine.advanceTo(9000);
    expect(ap.wtp?.phase).toBe('RUN');
    expect(client.tcpConnections?.some((connection) => connection.received.includes('CAPWAP HTTP'))).toBe(
      true
    );
    const channels = new Set<number>();
    for (const event of engine.state.events.filter((entry) => entry.type === 'FRAME_SENT')) {
      const packet = event.frame?.packet;
      if (packet?.protocol !== 'UDP' || packet.payload.protocol !== 'CAPWAP') continue;
      const channel = packet.sourcePort === 55000 ? packet.destinationPort : packet.sourcePort;
      channels.add(channel);
      expect(eventTone(event)).toBe(channel === 5246 ? 'control' : 'traffic');
      const dnsOnSamePorts: NetworkEvent = {
        ...event,
        frame: {
          ...event.frame!,
          packet: {
            ...packet,
            payload: {
              protocol: 'DNS',
              message: {
                type: 'query',
                transactionId: 1,
                question: { name: 'visual.lab', type: 'A' },
                recursionDesired: false,
              },
            },
          },
        },
      };
      expect(eventTone(dnsOnSamePorts)).toBe('traffic');
    }
    expect(channels).toEqual(new Set([5246, 5247]));
  });

  it.each(['vpn', 'sdwan'] as const)(
    'distingue negociação %s de dados encapsulados, mantendo políticas SDWAN como controle',
    (template) => {
      const engine = new SimulationEngine(makeTemplate(template));
      engine.advanceTo(8000);
      const client = engine.state.devices.find((device) => device.type === 'pc')!;
      const server = engine.state.devices.find((device) => device.type === 'server')!;
      engine.httpGet(client.id, server.interfaces[0].ip!);
      engine.advanceTo(8500);
      expect(
        client.tcpConnections?.some((connection) => connection.received.includes('HTTP pelo overlay'))
      ).toBe(true);
      const tunnelKinds = new Set<string>();
      const sdwanKinds = new Set<string>();
      for (const event of engine.state.events.filter((entry) => entry.type === 'FRAME_SENT')) {
        const packet = event.frame?.packet;
        if (packet?.protocol !== 'UDP') continue;
        if (packet.payload.protocol === 'TUNNEL') {
          tunnelKinds.add(packet.payload.message.kind);
          expect(eventTone(event)).toBe(packet.payload.message.kind === 'data' ? 'traffic' : 'control');
        } else if (packet.payload.protocol === 'SDWAN') {
          sdwanKinds.add(packet.payload.message.kind);
          expect(eventTone(event)).toBe('control');
        }
      }
      expect(tunnelKinds).toEqual(new Set(['hello', 'ack', 'auth', 'auth-ack', 'data']));
      expect(sdwanKinds).toEqual(new Set(template === 'sdwan' ? ['request', 'policies'] : []));
    }
  );

  it('mantém frames TCP como transporte sem presumir o serviço BGP pela porta', () => {
    const engine = new SimulationEngine(makeTemplate('bgp'));
    engine.advanceTo(8000);
    const frames = engine.state.events.filter(
      (event) => event.type === 'FRAME_SENT' && event.frame?.packet?.protocol === 'TCP'
    );
    const controls = engine.state.events.filter((event) => event.type === 'BGP_SENT');
    expect(frames.length).toBeGreaterThan(0);
    expect(controls.length).toBeGreaterThan(0);
    expect(frames.every((event) => eventTone(event) === 'traffic')).toBe(true);
    expect(controls.every((event) => eventTone(event) === 'control')).toBe(true);
  });

  it('usa apenas eventos posteriores ao cursor e limita a leitura quando ele saiu da retenção', () => {
    const { events } = lan();
    expect(newCanvasEvents(events, events.at(-1)?.id)).toEqual([]);
    const newest = events.at(-1)!;
    const history = Array.from({ length: 2000 }, (_, i) => ({ ...newest, id: 'event-' + i }));
    expect(newCanvasEvents(history, 'event-1997').map((event) => event.id)).toEqual([
      'event-1998',
      'event-1999',
    ]);
    expect(newCanvasEvents(history, 'event-1')).toHaveLength(CANVAS_ACTIVITY_LIMITS.events);
    expect(newCanvasEvents(history, undefined)).toHaveLength(CANVAS_ACTIVITY_LIMITS.events);
  });

  it('reconhece ida e volta do ping real sem mutar clock, filas ou contadores', () => {
    const { engine, events } = lan();
    expect(events.some((event) => event.type === 'PING_SUCCESS')).toBe(true);
    const before = engine.snapshot();
    const directions = new Set<boolean>();
    for (const event of events.filter((entry) => entry.type === 'FRAME_SENT')) {
      const activity = collectCanvasActivities(
        emptyCanvasActivities(),
        [event],
        engine.state.links,
        100,
        true
      );
      const packet = activity.links.get(event.link!)?.packet;
      expect(packet?.eventId).toBe(event.id);
      directions.add(packet!.reverse);
      expect(packet!.reverse).toBe(
        event.device === engine.state.links.find((link) => link.id === event.link)!.b.device
      );
    }
    expect(directions).toEqual(new Set([false, true]));
    const activity = collectCanvasActivities(emptyCanvasActivities(), events, engine.state.links, 100, true);
    expect(activity.devices.get(events.find((event) => event.type === 'PING_SUCCESS')!.device)?.tone).toBe(
      'success'
    );
    expect(engine.snapshot()).toEqual(before);
  });

  it('remove o marcador após uma perda real e nunca anima uma rejeição antes de transmitir', () => {
    const engine = new SimulationEngine(makeTemplate('lan'));
    engine.state.links[0].loss = 1;
    const client = engine.state.devices.find((device) => device.id === engine.state.links[0].a.device)!;
    const destination = engine.state.devices.find(
      (device) => device.type === 'pc' && device.id !== client.id
    )!;
    const cursor = engine.state.events.at(-1)?.id;
    engine.ping(client.id, destination.interfaces[0].ip!);
    const fresh = newCanvasEvents(engine.state.events, cursor);
    expect(fresh.some((event) => event.type === 'FRAME_SENT')).toBe(true);
    expect(fresh.some((event) => event.type === 'PACKET_DROPPED')).toBe(true);
    const activity = collectCanvasActivities(emptyCanvasActivities(), fresh, engine.state.links, 0, false);
    expect(activity.links.get(engine.state.links[0].id)?.tone).toBe('drop');
    expect(activity.links.get(engine.state.links[0].id)?.packet).toBeUndefined();
    const denied = { ...fresh.at(-1)!, id: 'event-denied', type: 'ACL_DENY' as const };
    expect(
      collectCanvasActivities(emptyCanvasActivities(), [denied], engine.state.links, 0, false).links.get(
        engine.state.links[0].id
      )?.packet
    ).toBeUndefined();
  });

  it('não atribui um descarte de porta compartilhada a um peer wireless arbitrário', () => {
    const { engine, events } = lan();
    const link = engine.state.links[0];
    const shared = [link, { ...link, id: 'link-other-peer', b: { device: 'other-peer', port: 'wlan0' } }];
    const drop: NetworkEvent = {
      ...events[0],
      id: 'event-drop',
      type: 'PACKET_DROPPED',
      device: link.a.device,
      port: link.a.port,
      link: undefined,
    };
    const activity = collectCanvasActivities(emptyCanvasActivities(), [drop], shared, 0, false);
    expect(activity.devices.get(link.a.device)?.tone).toBe('drop');
    expect(activity.links.size).toBe(0);
  });

  it('distingue controle ARP de PDUs que podem atravessar uma porta STP em discarding', () => {
    const { engine, events } = lan();
    const arp = events.find((event) => event.type === 'FRAME_SENT' && event.frame?.arp)!;
    expect(eventTone(arp)).toBe('control');
    expect(
      collectCanvasActivities(emptyCanvasActivities(), [arp], engine.state.links, 0, false).links.get(
        arp.link!
      )?.packet?.control
    ).toBe(false);
  });

  it('distingue gestão 802.11 de HTTP real transportado em frames protegidos', () => {
    const engine = new SimulationEngine();
    const ap = engine.addDevice('switch', { x: 200, y: 200 });
    const client = engine.addDevice('pc', { x: 240, y: 200 });
    const server = engine.addDevice('server', { x: 100, y: 200 });
    const config = {
      ssid: 'shLab',
      security: 'wpa2-psk',
      key: 'Wireless-123',
      band: '2.4',
      channel: 1,
      txPower: 20,
      noise: -95,
      attenuation: 0,
      enabled: true,
    };
    engine.configureWireless(ap.id, { ...config, role: 'ap' });
    engine.configureWireless(client.id, { ...config, role: 'client' });
    Object.assign(
      client.interfaces.find((port) => port.id === 'wlan0')!,
      { ip: '10.10.10.10', prefix: 24 }
    );
    Object.assign(server.interfaces[0], { ip: '10.10.10.20', prefix: 24 });
    engine.connect({ device: ap.id, port: 'p0' }, { device: server.id, port: 'p0' });
    engine.configureTcpService(server.id, { kind: 'http', port: 80, enabled: true, body: 'HTTP pelo rádio' });
    engine.advanceTo(5000);
    engine.httpGet(client.id, '10.10.10.20');
    engine.advanceTo(6000);
    const management = engine.state.events.find((event) => event.type === 'FRAME_SENT' && event.frame?.wifi)!;
    const data = engine.state.events.find((event) => event.type === 'FRAME_SENT' && event.frame?.secure)!;
    expect(management).toBeDefined();
    expect(data).toBeDefined();
    expect(eventTone(management)).toBe('control');
    expect(eventTone(data)).toBe('traffic');
    const packet = collectCanvasActivities(
      emptyCanvasActivities(),
      [management],
      engine.state.links,
      0,
      false
    ).links.get(management.link!)!.packet!;
    expect(packet.radioControl).toBe(true);
    expect(packet.control).toBe(true);
    expect(client.tcpConnections?.some((connection) => connection.received.includes('HTTP pelo rádio'))).toBe(
      true
    );
  });

  it.each([
    'ACL_DENY',
    'FIREWALL_DENY',
    'DOT1X_DENY',
    'PACKET_DROPPED',
    'QOS_DROP',
    'WIFI_AUTH_FAILED',
    'DNS_TIMEOUT',
    'DHCP_POOL_EXHAUSTED',
    'BGP_ROUTE_REJECTED',
  ] as const)('classifica %s pelo evento real, sem depender da frase da mensagem', (type) => {
    const event: NetworkEvent = {
      id: 'event-1',
      time: 0,
      type,
      device: 'device-1',
      reason: 'Mensagem localizada',
    };
    expect(eventTone(event)).toBe('drop');
  });

  it('limita highlights e expira o pacote original mesmo se um evento posterior mantém a conexão destacada', () => {
    const { engine, events } = lan();
    const sent = events.find((event) => event.type === 'FRAME_SENT')!;
    const links = Array.from({ length: 300 }, (_, i) => ({
      ...engine.state.links[0],
      id: 'link-' + i,
      a: { device: 'device-' + i, port: 'p0' },
    }));
    const batch = links.map((link, i) => ({
      ...sent,
      id: 'event-' + i,
      device: link.a.device,
      link: link.id,
    }));
    const activity = collectCanvasActivities(emptyCanvasActivities(), batch, links, 0, false);
    expect(activity.devices.size).toBe(CANVAS_ACTIVITY_LIMITS.devices);
    expect(activity.links.size).toBe(CANVAS_ACTIVITY_LIMITS.links);
    expect(activity.links.has('link-299')).toBe(true);
    expect(pruneCanvasActivities(activity, CANVAS_ACTIVITY_LIMITS.lifetime).links.size).toBe(0);
    const first = collectCanvasActivities(emptyCanvasActivities(), [sent], engine.state.links, 0, true);
    const second = collectCanvasActivities(
      first,
      [{ ...sent, id: 'event-later', type: 'MAC_LEARNED' }],
      engine.state.links,
      1000,
      false
    );
    expect(second.links.get(sent.link!)?.packet?.eventId).toBe(sent.id);
    expect(pruneCanvasActivities(second, 1400).links.get(sent.link!)?.packet).toBeUndefined();
    expect(pruneCanvasActivities(second, 1400).links.get(sent.link!)?.eventId).toBe('event-later');
  });
});
