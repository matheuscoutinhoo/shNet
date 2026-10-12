import { describe, expect, it } from 'vitest';
import { SimulationEngine, wirelessConfig, type NetworkEvent } from '@shlab/engine';
import { findDevices } from '../apps/web/src/workspace/deviceFinder';
import { explainEvent, eventLayers } from '../apps/web/src/workspace/eventEducation';
import { sectionLesson, sectionLessons, devicePurpose } from '../apps/web/src/workspace/educationalContent';

describe('Explicações ligadas ao acontecimento observado', () => {
  it('beacon real anuncia a rede sem afirmar que o cliente se associou', () => {
    const e = new SimulationEngine(),
      ap = e.addProfile('ap');
    e.configureWireless(ap.id, { ...wirelessConfig(ap), ssid: 'Campus', security: 'open', key: undefined });
    e.advanceTo(1500);
    const event = e.state.events.find((event) => event.frame?.wifi?.kind === 'beacon')!;
    expect(event).toBeDefined();
    expect(explainEvent(event).summary).toContain('não confirma associação');
    expect(explainEvent(event).summary).toContain('Campus');
    expect(eventLayers(event)).toEqual([
      [2, 'Enlace', 'Wi-Fi / IEEE 802.11'],
      [1, 'Física', 'Rádio'],
    ]);
  });
  it('falha com quadro preserva diagnóstico de falha e não afirma entrega', () => {
    const event = {
      id: 'e',
      time: 1000,
      device: 'd',
      type: 'PACKET_DROPPED',
      reason: 'ACL deny',
    } satisfies NetworkEvent;
    expect(explainEvent(event).failure).toBe(true);
    expect(explainEvent(event).summary).toContain('motivo específico');
    expect(eventLayers(event)).toEqual([]);
  });
  it('explica retransmissão sem concluir que foi perda de pacote', () => {
    const event = {
      id: 'e',
      time: 1000,
      device: 'd',
      type: 'TCP_RETRANSMIT',
      reason: 'RTO',
    } satisfies NetworkEvent;
    expect(explainEvent(event).summary).toContain('não distingue essas causas');
  });
  it('guias são específicos para telefone e IDS', () => {
    const e = new SimulationEngine(),
      phone = e.addFactoryProfile('phone'),
      ids = e.addFactoryProfile('ids');
    expect(sectionLesson('applications', phone)?.fields.map((f) => f[0])).toEqual(['Telefonia']);
    expect(sectionLesson('advancedNetwork', ids)?.fields.map((f) => f[0])).toEqual(['IDS / IPS']);
    expect(devicePurpose(phone)).toContain('sinalizar chamadas');
    for (const section of Object.values(sectionLessons)) {
      expect(section.purpose.length).toBeGreaterThan(60);
      expect(section.observe.length).toBeGreaterThan(40);
    }
  });
});
describe('Busca de equipamentos presentes na topologia', () => {
  it('prioriza nomes exatos, também resolve IP, IPv6 e MAC, sem inventar equipamentos', () => {
    const e = new SimulationEngine(),
      a = e.addProfile('desktop'),
      b = e.addProfile('desktop');
    a.hostname = 'Host';
    b.hostname = 'Host-2';
    a.interfaces[0].ip = '192.0.2.10';
    a.interfaces[0].prefix = 24;
    e.configureIpv6(a.id, a.interfaces[0].id, {
      auto: false,
      addresses: [{ ip: '2001:db8::10', prefix: 64 }],
    });
    expect(findDevices(e.state.devices, 'HOST').map((d) => d.id)).toEqual([a.id, b.id]);
    for (const q of [' 192.0.2.10 ', '2001:db8::10', a.interfaces[0].mac])
      expect(findDevices(e.state.devices, q).map((d) => d.id)).toEqual([a.id]);
    expect(findDevices(e.state.devices, 'equipamento-ausente')).toEqual([]);
    expect(findDevices(e.state.devices, ' ')).toEqual([]);
  });
});
