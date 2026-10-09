import type { SimulationEngine } from '../core/engine';
import type { Device } from '../model';
import { interfaceOperational } from './layer3';
import type { SnmpVarbind } from './snmp-model';
export function compareOids(a: string, b: string) {
  const left = a.split('.').map(Number),
    right = b.split('.').map(Number);
  for (let i = 0; i < Math.min(left.length, right.length); i++)
    if (left[i] !== right[i]) return left[i] - right[i];
  return left.length - right.length;
}
export function snmpMib(engine: SimulationEngine, device: Device): SnmpVarbind[] {
  const mib: SnmpVarbind[] = [
    {
      oid: '1.3.6.1.2.1.1.1.0',
      type: 'OctetString',
      value: 'NetOS · ' + device.type + ' · simulador educacional',
    },
    {
      oid: '1.3.6.1.2.1.1.3.0',
      type: 'TimeTicks',
      value: Math.floor((engine.state.clock - (device.snmpAgent?.startedAt ?? 0)) / 10) % 4294967296,
    },
    { oid: '1.3.6.1.2.1.1.5.0', type: 'OctetString', value: device.hostname },
    { oid: '1.3.6.1.2.1.2.1.0', type: 'Integer', value: device.interfaces.length },
    // 32473 is the documentation/example enterprise. These are shLab counters, not IF-MIB unicast counters.
    { oid: '1.3.6.1.4.1.32473.1.3.0', type: 'Counter64', value: device.dropped },
  ];
  for (const [index, port] of device.interfaces.entries()) {
    const suffix = '.' + (index + 1);
    mib.push(
      { oid: '1.3.6.1.2.1.2.2.1.1' + suffix, type: 'Integer', value: index + 1 },
      { oid: '1.3.6.1.2.1.2.2.1.2' + suffix, type: 'OctetString', value: port.name },
      { oid: '1.3.6.1.2.1.2.2.1.4' + suffix, type: 'Integer', value: port.mtu },
      {
        oid: '1.3.6.1.2.1.2.2.1.5' + suffix,
        type: 'Gauge32',
        value: Math.min(port.speed * 1000000, 4294967295),
      },
      { oid: '1.3.6.1.2.1.2.2.1.7' + suffix, type: 'Integer', value: port.adminUp ? 1 : 2 },
      {
        oid: '1.3.6.1.2.1.2.2.1.8' + suffix,
        type: 'Integer',
        value: interfaceOperational(engine.state, device, port) ? 1 : 2,
      },
      { oid: '1.3.6.1.2.1.31.1.1.1.15' + suffix, type: 'Gauge32', value: port.speed },
      { oid: '1.3.6.1.4.1.32473.1.1' + suffix, type: 'Counter64', value: port.rx },
      { oid: '1.3.6.1.4.1.32473.1.2' + suffix, type: 'Counter64', value: port.tx },
      { oid: '1.3.6.1.4.1.32473.1.4' + suffix, type: 'Counter64', value: port.errors }
    );
  }
  return mib.sort((a, b) => compareOids(a.oid, b.oid));
}
