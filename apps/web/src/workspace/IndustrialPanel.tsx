import { useState } from 'react';
import { configureModbus, modbusRequest, decodeModbus, modbusConfigSchema } from '@shlab/engine';
import type { LabController } from './useLab';
export function IndustrialPanel({ lab }: { lab: LabController }) {
  const candidates = lab.engine.state.devices.filter((d) => d.interfaces.some((p) => p.ip));
  const [source, setSource] = useState(
    candidates.find((d) => d.type === 'pc')?.id ?? candidates[0]?.id ?? ''
  );
  const [plc, setPlc] = useState(
    candidates.find((d) => d.modbus)?.id ?? candidates.find((d) => d.type === 'server')?.id ?? ''
  );
  const [request, setRequest] = useState(''),
    [requestSource, setRequestSource] = useState('');
  const target = lab.engine.state.devices.find((d) => d.id === plc);
  const connection = lab.engine.state.devices
    .find((d) => d.id === requestSource)
    ?.tcpConnections?.find((c) => c.id === request);
  let response = 'Aguardando resposta';
  if (connection?.received.includes('\n')) {
    try {
      const decoded = decodeModbus(connection.received.split('\n')[0]);
      response = decoded.exception
        ? `Exceção Modbus ${decoded.exception}`
        : decoded.function === 3
          ? 'Registradores: ' +
            Array.from(
              { length: decoded.pdu[1] / 2 },
              (_, i) => decoded.pdu[2 + i * 2] * 256 + decoded.pdu[3 + i * 2]
            ).join(', ')
          : 'Escrita confirmada';
    } catch (e) {
      response = (e as Error).message;
    }
  }
  return (
    <>
      <p>
        Modbus funções 03, 06 e 16 com registradores de 16 bits. Os endereços começam em zero. A aplicação
        simula a comunicação; não executa firmware ou lógica de processo do PLC.
      </p>
      <label>
        PLC / servidor
        <select
          value={plc}
          onChange={(e) => {
            setPlc(e.target.value);
            setRequest('');
          }}
        >
          {candidates
            .filter((d) => ['server', 'router'].includes(d.type))
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.hostname}
              </option>
            ))}
        </select>
      </label>
      {target && (
        <form
          key={plc}
          onSubmit={(event) => {
            event.preventDefault();
            const f = new FormData(event.currentTarget);
            lab.change((e) =>
              configureModbus(
                e,
                e.device(plc),
                modbusConfigSchema.parse({
                  enabled: f.get('enabled') === 'on',
                  port: Number(f.get('port')),
                  unit: Number(f.get('unit')),
                  registers: String(f.get('registers'))
                    .split(',')
                    .map((x) => Number(x.trim())),
                })
              )
            );
          }}
        >
          <label>
            <input name="enabled" type="checkbox" defaultChecked={target.modbus?.enabled ?? true} /> Servidor
            habilitado
          </label>
          <label>
            Porta
            <input
              name="port"
              type="number"
              min={1}
              max={65535}
              defaultValue={target.modbus?.port ?? 502}
              required
            />
          </label>
          <label>
            Unit ID
            <input
              name="unit"
              type="number"
              min={1}
              max={247}
              defaultValue={target.modbus?.unit ?? 1}
              required
            />
          </label>
          <label>
            Registradores separados por vírgula
            <textarea
              name="registers"
              rows={3}
              defaultValue={(target.modbus?.registers ?? Array(16).fill(0)).join(',')}
              required
            />
          </label>
          <button className="button">Aplicar configuração PLC</button>
        </form>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const f = new FormData(event.currentTarget),
            func = Number(f.get('function'));
          const id = lab.change(
            (e) =>
              modbusRequest(
                e,
                e.device(source),
                target!.interfaces.find((p) => p.ip)!.ip!,
                {
                  transaction: e.state.sequence % 65536,
                  unit: Number(f.get('unit')),
                  function: func,
                  address: Number(f.get('address')),
                  quantity: Number(f.get('quantity')),
                  values:
                    func === 3
                      ? []
                      : String(f.get('values'))
                          .split(',')
                          .map((x) => Number(x.trim())),
                },
                target?.modbus?.port ?? 502
              ),
            false
          );
          if (id) {
            setRequest(id);
            setRequestSource(source);
            lab.setPlaybackMode('realtime');
            lab.setPlaying(true);
          }
        }}
      >
        <label>
          HMI / origem
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            {candidates.map((d) => (
              <option key={d.id} value={d.id}>
                {d.hostname}
              </option>
            ))}
          </select>
        </label>
        <label>
          Operação
          <select name="function">
            <option value="3">03 — Ler holding registers</option>
            <option value="6">06 — Escrever um registro</option>
            <option value="16">16 — Escrever múltiplos</option>
          </select>
        </label>
        <label>
          Unit ID
          <input name="unit" type="number" min={1} max={247} defaultValue={1} required />
        </label>
        <label>
          Endereço inicial
          <input name="address" type="number" min={0} max={65535} defaultValue={0} required />
        </label>
        <label>
          Quantidade
          <input name="quantity" type="number" min={1} max={125} defaultValue={1} required />
        </label>
        <label>
          Valores para escrita
          <input name="values" defaultValue="0" />
        </label>
        <button className="button primary" disabled={!source || !target?.modbus?.enabled}>
          Executar transação
        </button>
      </form>
      {request && (
        <p role="status">
          {connection?.state} · {response}
        </p>
      )}
    </>
  );
}
