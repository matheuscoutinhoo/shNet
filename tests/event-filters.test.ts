import { describe, expect, it } from 'vitest';
import { SimulationEngine } from '@shlab/engine';
import {
  eventFilters,
  eventFiltersForSelection,
  matchesEventFilter,
} from '../apps/web/src/workspace/eventFilters';

describe('Categorias de eventos por equipamento', () => {
  it('oferece possibilidades antes de existirem eventos, conforme as capacidades do perfil', () => {
    const e = new SimulationEngine();
    const laptop = e.addFactoryProfile('laptop'),
      sw = e.addFactoryProfile('switch-l2'),
      router = e.addFactoryProfile('router'),
      rack = e.addFactoryProfile('rack');
    const ids = (d: typeof laptop) => eventFiltersForSelection([d], [], []).map(([id]) => id);
    expect(ids(laptop)).toContain('wireless');
    for (const id of ['ospf', 'rip', 'stp', 'bgp', 'policy']) expect(ids(laptop)).not.toContain(id);
    expect(ids(sw)).toContain('stp');
    expect(ids(sw)).toContain('lacp');
    expect(ids(sw)).not.toContain('ospf');
    expect(ids(router)).toContain('ospf');
    expect(ids(router)).toContain('policy');
    expect(ids(router)).not.toContain('stp');
    expect(ids(rack)).toEqual(['all']);
  });
  it('une as possibilidades da seleção múltipla e restaura todas ao limpar a seleção', () => {
    const e = new SimulationEngine(),
      laptop = e.addFactoryProfile('laptop'),
      sw = e.addFactoryProfile('switch-l2');
    const ids = eventFiltersForSelection([laptop, sw], [], []).map(([id]) => id);
    expect(ids).toContain('wireless');
    expect(ids).toContain('stp');
    expect(eventFiltersForSelection([], [], [])).toEqual(eventFilters);
  });
  it('preserva categorias de registros importados ou encaminhados, sem inferir OSPF de uma rota estática', () => {
    const e = new SimulationEngine(),
      sw = e.addFactoryProfile('switch-l2');
    e.emit('ROUTE_ADDED', sw.id, 'Static route');
    expect(eventFiltersForSelection([sw], e.state.events, []).map(([id]) => id)).not.toContain('ospf');
    e.emit('OSPF_RECEIVED', sw.id, 'Registro de uma configuração anterior');
    expect(eventFiltersForSelection([sw], e.state.events, []).map(([id]) => id)).toContain('ospf');
  });
  it('não classifica anúncio Wi-Fi como Ethernet', () => {
    const e = new SimulationEngine(),
      ap = e.addProfile('ap');
    e.advanceTo(1500);
    const beacon = e.state.events.find(
      (event) => event.device === ap.id && event.frame?.wifi?.kind === 'beacon'
    );
    expect(beacon).toBeDefined();
    expect(matchesEventFilter(beacon!, 'wireless', e.state.links)).toBe(true);
    expect(matchesEventFilter(beacon!, 'ethernet', e.state.links)).toBe(false);
  });
});
