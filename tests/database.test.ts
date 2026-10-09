import { describe, expect, it } from 'vitest';
import { SimulationEngine, addProfile, validateSnapshot } from '../packages/simulation-engine/src';
describe('Banco por HTTP/TCP', () => {
  it('executa CRUD pela rede, recusa chave e gramática inválidas e restaura tabelas', () => {
    const e = new SimulationEngine(),
      client = e.addDevice('pc'),
      server = addProfile(e, 'database');
    Object.assign(client.interfaces[0], { ip: '10.0.0.1', prefix: 24 });
    Object.assign(server.interfaces[0], { ip: '10.0.0.2', prefix: 24 });
    e.connect({ device: client.id, port: 'p0' }, { device: server.id, port: 'p0' });
    const query = (sql: string, key = 'database-key') => {
      const c = e.queryDatabase(client.id, '10.0.0.2', sql, key);
      e.advanceTo(e.state.clock + 300);
      return client.tcpConnections!.find((v) => v.id === c)!.received;
    };
    expect(query('CREATE TABLE sensores (id, valor)')).toContain('200 OK');
    expect(query('INSERT INTO sensores (id, valor) VALUES (1, 23.5)')).toContain('"affected":1');
    expect(query('SELECT * FROM sensores WHERE id = 1 LIMIT 10')).toContain('"valor":23.5');
    expect(query('UPDATE sensores SET valor = 24 WHERE id = 1')).toContain('"affected":1');
    expect(query('SELECT * FROM sensores', 'wrong-key')).toContain('401 Unauthorized');
    expect(query('SELECT * FROM sensores; DROP TABLE sensores')).toContain('400 Bad Request');
    expect(server.database?.tables[0].rows[0].valor).toBe(24);
    const resumed = new SimulationEngine(e.snapshot());
    expect(resumed.device(server.id).database?.tables[0].rows[0].valor).toBe(24);
    expect(query('DELETE FROM sensores WHERE id = 1')).toContain('"affected":1');
    expect(server.database?.tables[0].rows).toHaveLength(0);
    expect(
      e.state.events.some(
        (v) =>
          v.type === 'FRAME_SENT' &&
          v.frame?.packet?.protocol === 'TCP' &&
          v.frame.packet.data.includes('POST /query')
      )
    ).toBe(true);
    validateSnapshot(e.snapshot());
  });
});
