import { describe, expect, it } from 'vitest';
import { deviceProfiles, labs, makeTemplate } from '../packages/simulation-engine/src';
import { equipmentGroups, availablePorts } from '../apps/web/src/workspace/deviceCatalog';
import { conceptsForLab, labConcepts, networkConcepts } from '../apps/web/src/workspace/networkConcepts';

describe('Catálogo do canvas', () => {
  it('mostra cada perfil uma única vez e reúne a infraestrutura wireless', () => {
    const groups = equipmentGroups();
    const ids = groups.flatMap((group) => group.profiles.map((profile) => profile.id));
    expect(ids.sort()).toEqual(deviceProfiles.map((profile) => profile.id).sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(groups.filter((group) => group.category === 'Wireless')).toHaveLength(1);
    expect(
      groups
        .find((group) => group.category === 'Wireless')!
        .profiles.map((profile) => profile.id)
        .sort()
    ).toEqual(['ap', 'mesh', 'wlc']);
    expect(
      groups
        .find((group) => group.category === 'Dispositivos finais')!
        .profiles.some((profile) => profile.id === 'laptop')
    ).toBe(true);
  });
  it('encontra categorias com ou sem acento e omite grupos sem resultados', () => {
    expect(equipmentGroups('seguranca').map((group) => group.category)).toEqual(['Segurança']);
    expect(equipmentGroups(' equipamento inexistente xyz ')).toEqual([]);
    expect(
      equipmentGroups('notebook').flatMap((group) => group.profiles.map((profile) => profile.id))
    ).toEqual(['laptop']);
  });
  it('não oferece portas ocupadas ou de rádio para um novo cabo', () => {
    const state = makeTemplate('wireless');
    for (const device of state.devices) {
      for (const port of availablePorts(state, device)) {
        expect(port.media).not.toBe('wifi');
        expect(
          state.links.some((link) =>
            [link.a, link.b].some((end) => end.device === device.id && end.port === port.id)
          )
        ).toBe(false);
      }
    }
    const lan = makeTemplate('lan');
    expect(
      availablePorts(
        lan,
        lan.devices.find((device) => device.type === 'pc')!
      )
    ).toEqual([]);
  });
});

describe('Dicas por laboratório', () => {
  it('disponibiliza o catálogo completo somente no modo livre', () => {
    expect(conceptsForLab('free', null)).toHaveLength(networkConcepts.length);
    expect(conceptsForLab('free', 'ospf-repair')).toHaveLength(networkConcepts.length);
    const lan = conceptsForLab('guided', 'lan-foundations').map((topic) => topic.id);
    expect(lan).toEqual(expect.arrayContaining(['ethernet', 'ipv4', 'arp', 'icmp']));
    expect(lan).not.toEqual(expect.arrayContaining(['bgp']));
    expect(lan).not.toContain('wireless');
    expect(lan).not.toContain('dot1x');
  });
  it('separa protocolos de roteamento e famílias IP', () => {
    const ospf = conceptsForLab('challenge', 'ospf-repair').map((topic) => topic.id);
    expect(ospf).toContain('ospf');
    expect(ospf).not.toContain('bgp');
    expect(ospf).not.toContain('rip');
    const ipv6 = conceptsForLab('guided', 'ipv6-slaac').map((topic) => topic.id);
    expect(ipv6).toContain('ipv6');
    expect(ipv6).not.toContain('ipv4');
    expect(ipv6).not.toContain('arp');
  });
  it('mantém dicas de comunicação local e distingue modos de spanning tree', () => {
    const wireless = conceptsForLab('guided', 'wireless-repair').map((topic) => topic.id);
    expect(wireless).toContain('wireless');
    expect(wireless).not.toContain('routing');
    const lacp = conceptsForLab('challenge', 'lacp-repair').map((topic) => topic.id);
    expect(lacp).toEqual(expect.arrayContaining(['lacp', 'stp', 'tcp']));
    expect(lacp).not.toContain('routing');
    expect(lacp).not.toContain('spanning-instances');
    expect(conceptsForLab('free', null).map((topic) => topic.id)).toContain('spanning-instances');
  });
  it('cobre todas as trilhas sem conceitos duplicados ou referências ausentes', () => {
    for (const lab of labs) {
      const ids = labConcepts[lab.id];
      const available = conceptsForLab('guided', lab.id);
      expect(available.length).toBe(ids.length);
      expect(new Set(ids).size).toBe(ids.length);
      expect(available.length).toBeGreaterThan(0);
    }
    expect(new Set(networkConcepts.map((topic) => topic.id)).size).toBe(networkConcepts.length);
  });
});
