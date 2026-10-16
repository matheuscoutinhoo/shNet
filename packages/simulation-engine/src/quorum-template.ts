import { SimulationEngine } from './core/engine';

export function quorumTemplate() {
  const e = new SimulationEngine();
  const members = [
    e.addDevice('server', { x: 140, y: 100 }),
    e.addDevice('server', { x: 560, y: 100 }),
    e.addDevice('server', { x: 350, y: 390 }),
  ];
  members.forEach((d, i) => {
    d.hostname = 'QUORUM-' + (i + 1);
  });
  for (let a = 0; a < members.length; a++)
    for (let b = a + 1; b < members.length; b++)
      e.connect(
        { device: members[a].id, port: e.installNic(members[a].id).id },
        { device: members[b].id, port: e.installNic(members[b].id).id },
        'copper',
        { latency: 5 }
      );
  e.configureQuorumLab(members.map((d) => d.id));
  e.state.notes =
    'Avance 2 segundos para eleger o líder. Em Banco de dados, acompanhe o laboratório de quorum e proponha uma gravação no líder. A confirmação exige a resposta de uma maioria por cabos reais do modelo. Interrompa os dois cabos do líder: ele pode continuar se considerando líder, mas não confirma novas gravações. As duas réplicas restantes elegem outro líder. Reconecte os cabos para reconciliar o histórico não confirmado. A cópia local confirmada é histórica; não certifica leitura atual. Este armazenamento de estudo é independente do banco SQL e dos outros serviços. Compactação automática de prefixos confirmados; até 256 entradas retidas, 128 não confirmadas e 512 KiB por checkpoint, sem mudanças de membros. O canal de consenso não possui codec PCAP de fabricante.';
  return e.snapshot();
}
