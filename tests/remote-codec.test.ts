import { describe, it, expect } from 'vitest';
import {
  encodeRpc,
  decodeRpc,
  frameNetconf,
  readNetconf,
  readHttp,
  httpRequest,
  httpRpc,
} from '../packages/simulation-engine/src/protocols/remote-codec';
import { remoteRpcSchema } from '../packages/simulation-engine/src/protocols/remote-model';
describe('NETCONF XML e RESTCONF HTTP', () => {
  it('aceita nomes anteriores em laboratórios e emite o namespace shLab', () => {
    const rpc = remoteRpcSchema.parse({
      operation: 'patch',
      resource: '/restconf/data/netlab:network/hostname',
      patch: { hostname: 'R-LEGACY' },
    });
    const current = httpRequest('192.0.2.1', 'legacy', rpc);
    expect(current).toContain('/restconf/data/shlab:network/hostname');
    const legacyContent = current.replaceAll('shlab:network', 'netlab:network');
    const legacy = legacyContent.replace(
      /Content-Length: \d+/,
      'Content-Length: ' + Buffer.byteLength(legacyContent.split('\r\n\r\n')[1])
    );
    expect(httpRpc(readHttp(legacy)!).rpc).toMatchObject({
      resource: '/restconf/data/shlab:network/hostname',
      patch: { hostname: 'R-LEGACY' },
    });
    const xmlRpc = remoteRpcSchema.parse({
      operation: 'edit-config',
      datastore: 'candidate',
      patch: { hostname: 'R-LEGACY' },
    });
    const xml = encodeRpc('legacy-xml', xmlRpc);
    expect(xml).toContain('urn:shlab:yang:network');
    expect(decodeRpc(xml.replaceAll('urn:shlab:yang:network', 'urn:netlab:yang:network')).rpc).toEqual(
      xmlRpc
    );
  });
  it('preserva RPC e enquadra XML por octetos UTF-8 em base 1.1', () => {
    const rpc = remoteRpcSchema.parse({
        operation: 'edit-config',
        datastore: 'candidate',
        patch: { interfaces: [{ id: 'p0', description: 'Olá <rede> & segurança' }] },
      }),
      xml = encodeRpc('rpc-1', rpc),
      framed = frameNetconf(xml, '1.1');
    expect(readNetconf(framed.slice(0, -1), '1.1')).toBeUndefined();
    expect(readNetconf(framed, '1.1')?.message).toBe(xml);
    expect(decodeRpc(xml)).toEqual({ id: 'rpc-1', rpc });
    expect(() =>
      decodeRpc('<!DOCTYPE rpc [<!ENTITY x SYSTEM "file:///etc/passwd">]><rpc>&x;</rpc>')
    ).toThrow();
    expect(() => readNetconf('\n#1\né\n##\n', '1.1')).toThrow('UTF-8');
  });
  it('transporta recurso/If-Match e recusa cabeçalhos duplicados', () => {
    const rpc = remoteRpcSchema.parse({
        operation: 'patch',
        resource: '/restconf/data/shlab:network/hostname',
        patch: { hostname: 'R-PATCH' },
        ifMatch: 3,
      }),
      message = readHttp(httpRequest('192.0.2.1', 'rpc-2', rpc));
    expect(message?.method).toBe('PATCH');
    expect(message?.headers['if-match']).toBe('"3"');
    expect(httpRpc(message!).rpc).toMatchObject({ operation: 'patch', ifMatch: 3, resource: rpc.resource });
    expect(() =>
      readHttp('GET /restconf/data/shlab:network HTTP/1.1\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n')
    ).toThrow('duplicado');
  });
});
