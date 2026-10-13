import { describe, it, expect } from 'vitest';
import {
  SimulationEngine,
  makeTemplate,
  validateSnapshot,
  exportPcap,
  decodePcap,
  modbusRequest,
  decodeModbus,
  wirelessConfig,
} from '../packages/simulation-engine/src';
const device = (e: SimulationEngine, name: string) => e.state.devices.find((d) => d.hostname === name)!;
const advance = (e: SimulationEngine, ms = 1000) => e.advanceTo(e.state.clock + ms, 100000);
function ping(e: SimulationEngine, source: string, target: string, allowed = true) {
  const id = e.ping(device(e, source).id, target);
  advance(e);
  expect(e.state.probes.find((p) => p.id === id)?.status === 'success').toBe(allowed);
}
function http(e: SimulationEngine, source: string, target: string, allowed = true) {
  const d = device(e, source),
    id = e.httpGet(d.id, target);
  advance(e);
  expect(d.tcpConnections?.find((c) => c.id === id)?.received.includes('200 OK') ?? false).toBe(allowed);
}
const fault = (e: SimulationEngine, name: string) => {
  e.setDevicePower(device(e, name).id, false);
  advance(e, 5000);
};
const dhcp = (e: SimulationEngine) => {
  const d = device(e, 'PC-FINANCEIRO');
  e.requestDhcp(d.id, 'p0');
  advance(e, 3000);
  expect(d.interfaces[0].dhcp?.status).toBe('bound');
  expect(d.interfaces[0].ip).toMatch(/^10\.20\.10\./);
};
const ups = (e: SimulationEngine, name: string) => {
  const d = device(e, name);
  e.configureInfrastructure(d.id, { ...d.infrastructure, mains: false, remainingWh: 0 });
};
type Case = { id: string; name: string; check: (e: SimulationEngine) => void };
const cases: Case[] = [
  { id: 'S01', name: 'HMI-A para PLC-A local', check: (e) => ping(e, 'HMI-A', '10.20.40.10') },
  { id: 'S02', name: 'SCADA para PLC-A autorizado', check: (e) => ping(e, 'SCADA', '10.20.40.10') },
  { id: 'S03', name: 'SCADA para PLC-B autorizado', check: (e) => ping(e, 'SCADA', '10.20.50.10') },
  { id: 'S04', name: 'TI para PLC bloqueado', check: (e) => ping(e, 'PC-ERP', '10.20.40.10', false) },
  { id: 'S05', name: 'Células isoladas por política', check: (e) => ping(e, 'HMI-A', '10.20.50.10', false) },
  { id: 'S06', name: 'TI para MES HTTP', check: (e) => http(e, 'PC-ERP', '10.20.20.10') },
  {
    id: 'S07',
    name: 'Visitante para PLC bloqueado',
    check: (e) => ping(e, 'NOTEBOOK-VISITANTE', '10.20.40.10', false),
  },
  {
    id: 'S08',
    name: 'Visitante para MES agora bloqueado',
    check: (e) => http(e, 'NOTEBOOK-VISITANTE', '10.20.20.10', false),
  },
  {
    id: 'S09',
    name: 'DNS DMZ',
    check: (e) => {
      const d = device(e, 'PC-ERP');
      e.lookupDns(d.id, 'mes.fabrica.test');
      advance(e, 1000);
      expect(d.dnsQueries?.at(-1)?.status).toBe('success');
    },
  },
  { id: 'S10', name: 'DHCP por relay', check: dhcp },
  {
    id: 'S11',
    name: 'MQTT retained e assinatura wildcard',
    check: (e) => {
      const sensor = device(e, 'SENSOR-A'),
        scada = device(e, 'SCADA');
      e.connectIot(sensor.id, '10.20.30.20');
      e.connectIot(scada.id, '10.20.30.20');
      advance(e, 2000);
      e.subscribeIot(scada.id, 'fabrica/+/temperatura');
      advance(e, 500);
      e.publishIot(sensor.id, 'fabrica/A/temperatura', '72.5', true, 1);
      advance(e);
      expect(scada.iot?.readings.at(-1)?.payload).toBe('72.5');
      expect(sensor.iot?.publications?.at(-1)?.status).toBe('acked');
    },
  },
  {
    id: 'S12',
    name: 'Perda do uplink primário da célula A',
    check: (e) => {
      e.setPort(device(e, 'SW-A').id, 'p6', false);
      advance(e, 5000);
      ping(e, 'SCADA', '10.20.40.10');
    },
  },
  {
    id: 'S13',
    name: 'Perda FW-A e VRRP',
    check: (e) => {
      fault(e, 'FW-A');
      expect(device(e, 'FW-B').vrrp?.groups.some((g) => g.state === 'ACTIVE')).toBe(true);
      ping(e, 'SCADA', '10.20.40.10');
    },
  },
  {
    id: 'S14',
    name: 'Dois uplinks da célula A indisponíveis',
    check: (e) => {
      e.setPort(device(e, 'SW-A').id, 'p6', false);
      e.setPort(device(e, 'SW-A').id, 'p7', false);
      advance(e, 5000);
      ping(e, 'SCADA', '10.20.40.10', false);
    },
  },
  {
    id: 'S15',
    name: 'Restaurar uplink após isolamento',
    check: (e) => {
      const sw = device(e, 'SW-A');
      e.setPort(sw.id, 'p6', false);
      e.setPort(sw.id, 'p7', false);
      advance(e, 5000);
      ping(e, 'SCADA', '10.20.40.10', false);
      e.setPort(sw.id, 'p6', true);
      advance(e, 5000);
      ping(e, 'SCADA', '10.20.40.10');
    },
  },
  {
    id: 'S16',
    name: 'DNS indisponível sem cache',
    check: (e) => {
      const pc = device(e, 'PC-ERP');
      e.setDnsEnabled(device(e, 'DNS-DMZ').id, false);
      e.clearDnsCache(pc.id);
      e.lookupDns(pc.id, 'mes.fabrica.test');
      advance(e, 11000);
      expect(pc.dnsQueries?.at(-1)?.status).not.toBe('success');
    },
  },
  {
    id: 'S17',
    name: 'MES HTTP indisponível',
    check: (e) => {
      e.configureTcpService(device(e, 'MES-DMZ').id, { kind: 'http', port: 80, enabled: false, body: '' });
      http(e, 'PC-ERP', '10.20.20.10', false);
    },
  },
  {
    id: 'S18',
    name: 'Persistência de ping pendente',
    check: (e) => {
      const id = e.ping(device(e, 'SCADA').id, '10.20.40.10');
      e.step();
      const restored = new SimulationEngine(e.snapshot());
      advance(restored);
      expect(restored.state.probes.find((p) => p.id === id)?.status).toBe('success');
    },
  },
  {
    id: 'S19',
    name: 'DHCP após perda do primário corrigido',
    check: (e) => {
      fault(e, 'FW-A');
      dhcp(e);
    },
  },
  {
    id: 'S20',
    name: 'Cobre 150 m inoperante',
    check: (e) => {
      const link = e.state.links.find((l) => l.a.device === device(e, 'PLC-A').id)!;
      link.distance = 150;
      ping(e, 'HMI-A', '10.20.40.10', false);
      expect(() => validateSnapshot(e.snapshot())).toThrow('Distância');
      link.distance = 10;
    },
  },
  { id: 'S21', name: 'CFTV para serviço NVR substituto', check: (e) => http(e, 'CAM-01', '10.20.60.10') },
  { id: 'S22', name: 'CFTV para OT bloqueado', check: (e) => ping(e, 'CAM-01', '10.20.40.10', false) },
  {
    id: 'S23',
    name: 'NMS consulta SNMP do SCADA',
    check: (e) => {
      const nms = device(e, 'NMS-SYSLOG');
      e.querySnmp(nms.id, '10.20.30.10', 'factory-test', ['1.3.6.1.2.1.1.5.0'], 'get');
      advance(e);
      expect(nms.snmpQueries?.at(-1)?.status).toBe('success');
    },
  },
  {
    id: 'S24',
    name: 'Wi-Fi com chave incorreta',
    check: (e) => {
      const d = device(e, 'NOTEBOOK-VISITANTE');
      e.configureWireless(d.id, { ...wirelessConfig(d), key: 'Wrong-Key-Test' });
      advance(e, 12000);
      expect(d.wireless?.phase).not.toBe('associated');
      ping(e, 'NOTEBOOK-VISITANTE', '10.20.70.1', false);
    },
  },
  {
    id: 'S25',
    name: 'MTU DF 2000 bytes',
    check: (e) => {
      const id = e.ping(device(e, 'HMI-A').id, '10.20.40.10', 64, undefined, 2000, true);
      advance(e);
      expect(e.state.probes.find((p) => p.id === id)?.status).not.toBe('success');
    },
  },
  { id: 'S26', name: 'TI para suporte WAN HTTP', check: (e) => http(e, 'PC-ERP', '198.51.100.10') },
  {
    id: 'S27',
    name: 'SCADA para PLC com leitura Modbus real do modelo',
    check: (e) => {
      const scada = device(e, 'SCADA'),
        id = modbusRequest(e, scada, '10.20.40.10', {
          transaction: 1,
          unit: 1,
          function: 3,
          address: 0,
          quantity: 1,
        });
      advance(e);
      expect(Array.from(decodeModbus(scada.tcpConnections!.find((c) => c.id === id)!.received).pdu)).toEqual([
        3, 2, 2, 213,
      ]);
    },
  },
  {
    id: 'S28',
    name: 'TI para PLC Modbus bloqueado',
    check: (e) => {
      const d = device(e, 'PC-ERP'),
        id = modbusRequest(e, d, '10.20.40.10', { transaction: 1, unit: 1, function: 3, address: 0 });
      advance(e);
      expect(d.tcpConnections!.find((c) => c.id === id)!.received).toBe('');
    },
  },
  {
    id: 'S29',
    name: 'Snapshot convergido restaura integralmente',
    check: (e) => expect(new SimulationEngine(e.snapshot()).snapshot()).toEqual(e.snapshot()),
  },
  {
    id: 'S30',
    name: 'VRRP retorno e preempção',
    check: (e) => {
      fault(e, 'FW-A');
      e.setDevicePower(device(e, 'FW-A').id, true);
      advance(e, 5000);
      expect(device(e, 'FW-A').vrrp?.groups.some((g) => g.state === 'ACTIVE')).toBe(true);
      ping(e, 'SCADA', '10.20.40.10');
    },
  },
  {
    id: 'S31',
    name: 'WAN após falha FW-A com retorno pelo VIP',
    check: (e) => {
      fault(e, 'FW-A');
      http(e, 'PC-ERP', '198.51.100.10');
    },
  },
  {
    id: 'S32',
    name: 'Falha da distribuição primária',
    check: (e) => {
      fault(e, 'DIST-A');
      ping(e, 'SCADA', '10.20.40.10');
    },
  },
  {
    id: 'S33',
    name: 'PCAP HTTP decodificável',
    check: (e) => {
      http(e, 'PC-ERP', '10.20.20.10');
      const p = exportPcap(e.state);
      expect(p.packets).toBeGreaterThan(0);
      expect(decodePcap(p.bytes)).toHaveLength(p.packets);
    },
  },
  {
    id: 'S34',
    name: 'Retenção após controle RSTP/VRRP',
    check: (e) => {
      ping(e, 'SCADA', '10.20.40.10');
      advance(e, 5000);
      expect(e.state.diagnostics?.some((ev) => ev.type === 'PING_SUCCESS')).toBe(true);
      expect(exportPcap(e.state).packets).toBeGreaterThan(0);
    },
  },
  {
    id: 'S35',
    name: 'NTP no gerenciamento',
    check: (e) => {
      const d = device(e, 'ADMIN-REDE');
      e.configureClock(device(e, 'NTP-MGMT').id, { offsetMs: 0, server: true, stratum: 1 });
      e.configureClock(d.id, { offsetMs: 250, server: false, stratum: 2 });
      e.configureNtp(d.id, { enabled: true, servers: ['10.20.99.123'], intervalMs: 5000 });
      advance(e, 3000);
      expect(Math.abs(d.networkClock!.offsetMs)).toBeLessThan(1);
    },
  },
  {
    id: 'S36',
    name: 'Syslog no gerenciamento',
    check: (e) => {
      const d = device(e, 'ADMIN-REDE'),
        nms = device(e, 'NMS-SYSLOG');
      e.setSyslogEnabled(nms.id, true);
      e.configureSyslog(d.id, { enabled: true, server: '10.20.99.10', automatic: false });
      e.sendSyslog(d.id, 'Manutenção da fábrica');
      advance(e);
      expect(nms.syslogServer?.entries.some((x) => x.message.text === 'Manutenção da fábrica')).toBe(true);
    },
  },
  {
    id: 'S37',
    name: 'Syslog no switch L2 com SVI',
    check: (e) => {
      const d = device(e, 'SW-TI'),
        p = e.addSvi(d.id, 99);
      Object.assign(p, { ip: '10.20.99.21', prefix: 24 });
      d.gateway = '10.20.99.1';
      e.setSyslogEnabled(device(e, 'NMS-SYSLOG').id, true);
      e.configureSyslog(d.id, { enabled: true, server: '10.20.99.10', automatic: false });
      e.sendSyslog(d.id, 'Gerência L2');
      advance(e);
      expect(
        device(e, 'NMS-SYSLOG').syslogServer?.entries.some((x) => x.message.text === 'Gerência L2')
      ).toBe(true);
      expect(!!d.ipRouting).toBe(false);
    },
  },
  {
    id: 'S38',
    name: 'Relay backup e pools disjuntos',
    check: (e) => {
      fault(e, 'FW-A');
      dhcp(e);
      expect(Number(device(e, 'PC-FINANCEIRO').interfaces[0].ip!.split('.').at(-1))).toBeGreaterThanOrEqual(
        111
      );
    },
  },
  {
    id: 'S39',
    name: 'Nova sessão WAN após failover corrigido',
    check: (e) => {
      fault(e, 'FW-A');
      http(e, 'PC-ERP', '198.51.100.10');
    },
  },
  {
    id: 'S40',
    name: 'UPS A sem rede e bateria',
    check: (e) => {
      ups(e, 'UPS-A');
      advance(e, 5000);
      expect(device(e, 'FW-A').power).toBe(false);
      ping(e, 'SCADA', '10.20.40.10');
    },
  },
  { id: 'S41', name: 'SCADA PLC pelo patch panel', check: (e) => ping(e, 'SCADA', '10.20.40.10') },
  {
    id: 'S42',
    name: 'Perda das duas UPS interrompe OT',
    check: (e) => {
      ups(e, 'UPS-A');
      ups(e, 'UPS-B');
      advance(e);
      expect(device(e, 'FW-A').power).toBe(false);
      expect(device(e, 'FW-B').power).toBe(false);
      ping(e, 'SCADA', '10.20.40.10', false);
    },
  },
];
describe('Matriz de regressão da fábrica auditada', () => {
  it.each(cases)(
    '$id — $name',
    ({ check }) => {
      const e = new SimulationEngine(makeTemplate('factory'));
      check(e);
      validateSnapshot(e.snapshot());
    },
    60000
  );
});
