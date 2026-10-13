import type { Snapshot } from './model';
import { scenarioSchema, type Scenario } from './scenarios-model';
export function factoryScenarios(snapshot: Snapshot): Scenario[] {
  const flows = ['A', 'B'].flatMap((cell) => {
    const hmi = snapshot.devices.find((d) => d.hostname === 'HMI-' + cell);
    const plc = snapshot.devices.find((d) => d.hostname === 'PLC-' + cell && d.modbus?.enabled);
    const ip = plc?.interfaces.find((p) => p.ip)?.ip;
    return hmi && plc?.modbus && ip
      ? [
          {
            name: 'HMI-' + cell + ' → PLC-' + cell,
            source: hmi.hostname,
            target: ip,
            protocol: 'modbus',
            expect: 'allow',
            maxLossPercent: 0,
            modbus: {
              transaction: cell === 'A' ? 1 : 2,
              unit: plc.modbus.unit,
              function: 3,
              address: 0,
              quantity: 1,
            },
            expectedRegisters: [plc.modbus.registers[0]],
          },
        ]
      : [];
  });
  if (!flows.length) return [];
  const scada = snapshot.devices.find((d) => d.hostname === 'SCADA');
  if (scada)
    flows.push(
      ...flows.map((flow) => ({
        ...flow,
        name: 'SCADA → ' + flow.name.split(' → ')[1],
        source: scada.hostname,
      }))
    );
  const base = { durationMs: 10000, intervalMs: 1000, deadlineMs: 1000, flows, faults: [] };
  const scenarios: Scenario[] = [scenarioSchema.parse({ ...base, name: 'PLC/HMI — baseline Modbus' })];
  for (const [target, name, loss] of [
    ['FW-A', 'Perda do firewall primário', 50],
    ['DIST-A', 'Perda da distribuição primária', 50],
    ['SW-A', 'Isolamento da célula A', 50],
    ['PLC-A', 'PLC A indisponível', 50],
    ['SCADA', 'SCADA indisponível: HMI local independente', 0],
  ] as const) {
    if (!snapshot.devices.some((d) => d.hostname === target)) continue;
    scenarios.push(
      scenarioSchema.parse({
        ...base,
        name,
        flows: flows.map((f) => ({
          ...f,
          maxLossPercent: target === 'SCADA' && f.source === 'SCADA' ? 50 : loss,
          requireFinalSuccess: true,
        })),
        faults: [
          { atMs: 2000, kind: 'device', target, up: false },
          { atMs: 6000, kind: 'device', target, up: true },
        ],
      })
    );
  }
  const visitor = snapshot.devices.find((d) => d.hostname === 'NOTEBOOK-VISITANTE');
  const mes = snapshot.devices.find((d) => d.hostname === 'MES-DMZ');
  const mesIp = mes?.interfaces.find((p) => p.ip)?.ip;
  if (visitor && mesIp)
    scenarios.push(
      scenarioSchema.parse({
        ...base,
        name: 'Segmentação de visitantes',
        flows: [
          {
            name: 'Visitante → MES bloqueado',
            source: visitor.hostname,
            target: mesIp,
            protocol: 'http',
            expect: 'deny',
          },
          {
            name: 'Visitante → PLC bloqueado',
            source: visitor.hostname,
            target: flows[0].target,
            protocol: 'modbus',
            modbus: flows[0].modbus,
            expect: 'deny',
          },
        ],
      })
    );
  const ip = (name: string) =>
    snapshot.devices.find((d) => d.hostname === name)?.interfaces.find((p) => p.ip)?.ip;
  const add = (name: string, flow: unknown, faults: unknown[] = [], deadlineMs = 1000) =>
    scenarios.push(
      scenarioSchema.parse({
        name,
        durationMs: 10000,
        intervalMs: Math.max(1000, deadlineMs),
        deadlineMs,
        flows: [flow],
        faults,
      })
    );
  if (ip('PC-ERP') && ip('DNS-DMZ')) {
    const flow = {
      name: 'Resolver MES',
      source: 'PC-ERP',
      target: ip('DNS-DMZ'),
      protocol: 'dns',
      dns: { name: 'mes.fabrica.test', expectedAnswers: [mesIp] },
      expect: 'allow',
    };
    add('DNS — resposta sem cache', flow);
    add('DNS — falha e restauração do serviço', { ...flow, maxLossPercent: 50, requireFinalSuccess: true }, [
      { atMs: 2000, kind: 'service', target: 'DNS-DMZ', service: 'dns', up: false },
      { atMs: 6000, kind: 'service', target: 'DNS-DMZ', service: 'dns', up: true },
    ]);
  }
  if (ip('PC-FINANCEIRO') && ip('DHCP-DMZ'))
    add(
      'DHCP — concessões por relay',
      {
        name: 'Concessão TI',
        source: 'PC-FINANCEIRO',
        target: ip('DHCP-DMZ'),
        protocol: 'dhcp',
        dhcp: { interface: 'p0', expectedServer: ip('DHCP-DMZ') },
        expect: 'allow',
      },
      [],
      3000
    );
  if (ip('SENSOR-A') && ip('BROKER-OT') && scada)
    add('MQTT — publicação QoS 1 e assinatura wildcard', {
      name: 'Temperatura A',
      source: 'SENSOR-A',
      target: ip('BROKER-OT'),
      protocol: 'mqtt',
      mqtt: {
        operation: 'publish',
        topic: 'fabrica/A/temperatura',
        payload: '72.5',
        retain: true,
        receiver: 'SCADA',
        filter: 'fabrica/+/temperatura',
      },
      expect: 'allow',
    });
  if (ip('NMS-SYSLOG') && ip('SCADA'))
    add('SNMP — identidade do SCADA', {
      name: 'sysName',
      source: 'NMS-SYSLOG',
      target: ip('SCADA'),
      protocol: 'snmp',
      snmp: {
        community: scada?.snmpAgent?.community ?? 'factory-test',
        oids: ['1.3.6.1.2.1.1.5.0'],
        expectedVarbinds: [{ oid: '1.3.6.1.2.1.1.5.0', type: 'OctetString', value: 'SCADA' }],
      },
      expect: 'allow',
    });
  if (ip('ADMIN-REDE') && ip('NTP-MGMT'))
    add('NTP — sincronismo de gerenciamento', {
      name: 'Sincronizar relógio',
      source: 'ADMIN-REDE',
      target: ip('NTP-MGMT'),
      protocol: 'ntp',
      ntp: { maxOffsetMs: 1 },
      expect: 'allow',
    });
  if (ip('ADMIN-REDE') && ip('NMS-SYSLOG'))
    add('Syslog — recepção no coletor', {
      name: 'Manutenção',
      source: 'ADMIN-REDE',
      target: ip('NMS-SYSLOG'),
      protocol: 'syslog',
      syslog: { text: 'Manutenção da fábrica' },
      expect: 'allow',
    });
  if (ip('PC-ERP') && mesIp)
    add(
      'MES — falha e restauração HTTP',
      {
        name: 'MES HTTP',
        source: 'PC-ERP',
        target: mesIp,
        protocol: 'http',
        expect: 'allow',
        maxLossPercent: 50,
        requireFinalSuccess: true,
      },
      [
        { atMs: 2000, kind: 'service', target: 'MES-DMZ', service: 'http', up: false },
        { atMs: 6000, kind: 'service', target: 'MES-DMZ', service: 'http', up: true },
      ]
    );
  for (const target of ['UPS-A', 'UPS-B'])
    if (snapshot.devices.some((d) => d.hostname === target && d.infrastructure?.kind === 'ups'))
      scenarios.push(
        scenarioSchema.parse({
          ...base,
          name: target + ' — perda e restauração da alimentação',
          flows: flows.map((f) => ({ ...f, maxLossPercent: 50, requireFinalSuccess: true })),
          faults: [
            { atMs: 2000, kind: 'power', target, up: false },
            { atMs: 6000, kind: 'power', target, up: true },
          ],
        })
      );
  return scenarios;
}
