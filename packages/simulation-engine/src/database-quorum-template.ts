import { SimulationEngine } from './core/engine';

export function databaseQuorumTemplate() {
  const e = new SimulationEngine(),
    members = [
      e.addDevice('server', { x: 120, y: 80 }),
      e.addDevice('server', { x: 440, y: 80 }),
      e.addDevice('server', { x: 280, y: 300 }),
    ],
    sw = e.addDevice('switch', { x: 660, y: 240 }),
    client = e.addDevice('pc', { x: 880, y: 240 });
  members.forEach((d, i) => {
    d.hostname = 'SQL-' + (i + 1);
    Object.assign(d.interfaces[0], { ip: '10.90.0.' + (11 + i), prefix: 24 });
    e.configureDatabase(d.id, { enabled: true, port: 8080, key: 'database-key' });
    e.connect({ device: d.id, port: 'p0' }, { device: sw.id, port: 'p' + i });
  });
  sw.hostname = 'SQL-LAN';
  client.hostname = 'SQL-CLIENT';
  Object.assign(client.interfaces[0], { ip: '10.90.0.1', prefix: 24 });
  e.connect({ device: client.id, port: 'p0' }, { device: sw.id, port: 'p3' });
  for (let a = 0; a < members.length; a++)
    for (let b = a + 1; b < members.length; b++)
      e.connect(
        { device: members[a].id, port: e.installNic(members[a].id).id },
        { device: members[b].id, port: e.installNic(members[b].id).id },
        'copper',
        { latency: 5 }
      );
  e.configureQuorumLab(members.map((d) => d.id));
  e.configureDatabaseHa(members[0].id);
  e.configureDatabaseClient(client.id, {
    cluster: members[0].databaseHa!.cluster,
    targets: members.map((d) => d.interfaces[0].ip!),
    port: 8080,
    key: 'database-key',
  });
  e.state.notes =
    'Avance 2 segundos e identifique o líder no painel Banco de dados. Pelo SQL-CLIENT, envie CREATE TABLE sensores (id, valor) ao IP individual desse líder (10.90.0.11/12/13), porta 8080, chave database-key. INSERT e SELECT só respondem após confirmação de maioria. Desligue o líder, avance 2 segundos e consulte o novo líder: os dados confirmados permanecem. Isole apenas os dois cabos dedicados do antigo líder para estudar partição: ele pode manter o papel local, mas não responde sucesso sem maioria. SELECT também exige confirmação nova. Timeout de gravação tem resultado indeterminado; consulte antes de repetir. Não há failover automático de endereço ou TCP. Compactação automática; até 256 entradas retidas, 128 não confirmadas e 512 KiB por checkpoint. Remover membro/grupo desabilita os bancos preservando seus dados locais.';
  return e.snapshot();
}
