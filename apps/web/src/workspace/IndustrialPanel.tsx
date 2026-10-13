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
  const [operation, setOperation] = useState(3),
    [requestQuantity, setRequestQuantity] = useState(1);
  const target = lab.engine.state.devices.find((d) => d.id === plc);
  const connection = lab.engine.state.devices
    .find((d) => d.id === requestSource)
    ?.tcpConnections?.find((c) => c.id === request);
  let response = 'Aguardando resposta';
  if (connection?.responseAt !== undefined) {
    try {
      const decoded = decodeModbus(connection.received);
      response = decoded.exception
        ? `Exceção Modbus ${decoded.exception}`
        : [3, 4].includes(decoded.function)
          ? 'Registradores: ' +
            Array.from(
              { length: decoded.pdu[1] / 2 },
              (_, i) => decoded.pdu[2 + i * 2] * 256 + decoded.pdu[3 + i * 2]
            ).join(', ')
          : [1, 2].includes(decoded.function)
            ? 'Bits: ' +
              Array.from({ length: Math.min(requestQuantity, Number(decoded.pdu[1]) * 8) }, (_, i) =>
                Number(!!(decoded.pdu[2 + (i >> 3)] & (1 << (i % 8))))
              ).join(', ')
            : 'Escrita confirmada';
    } catch (e) {
      response = (e as Error).message;
    }
  }
  return (
    <>
      <p>
        Modbus TCP binário: funções 01/02/03/04/05/06/15/16, coils e registradores de 16 bits. Os endereços
        começam em zero. A aplicação simula a comunicação; não executa firmware ou lógica de processo do PLC.
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
                  ...target.modbus,
                  enabled: f.get('enabled') === 'on',
                  port: Number(f.get('port')),
                  unit: Number(f.get('unit')),
                  registers: String(f.get('registers'))
                    .split(',')
                    .map((x) => Number(x.trim())),
                  inputRegisters: String(f.get('inputRegisters')).trim()
                    ? String(f.get('inputRegisters')).split(',').map(Number)
                    : [],
                  coils: String(f.get('coils')).trim()
                    ? String(f.get('coils'))
                        .split(',')
                        .map((v) => {
                          if (!/^[01]$/.test(v.trim())) throw new Error('Coils exigem 0 ou 1.');
                          return v.trim() === '1';
                        })
                    : [],
                  discreteInputs: String(f.get('discreteInputs')).trim()
                    ? String(f.get('discreteInputs'))
                        .split(',')
                        .map((v) => {
                          if (!/^[01]$/.test(v.trim())) throw new Error('Entradas exigem 0 ou 1.');
                          return v.trim() === '1';
                        })
                    : [],
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
          <label>
            Input registers separados por vírgula
            <textarea
              name="inputRegisters"
              rows={2}
              defaultValue={target.modbus?.inputRegisters?.join(',') ?? ''}
            />
          </label>
          <label>
            Coils (0/1) separados por vírgula
            <textarea
              name="coils"
              rows={2}
              defaultValue={target.modbus?.coils?.map(Number).join(',') ?? ''}
            />
          </label>
          <label>
            Entradas discretas (0/1) separadas por vírgula
            <textarea
              name="discreteInputs"
              rows={2}
              defaultValue={target.modbus?.discreteInputs?.map(Number).join(',') ?? ''}
            />
          </label>
          <button className="button">Aplicar configuração PLC</button>
        </form>
      )}
      <form
        key={'request-' + plc}
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
                  values: [1, 2, 3, 4].includes(func)
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
            setRequestQuantity(Number(f.get('quantity')));
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
          <select name="function" value={operation} onChange={(e) => setOperation(Number(e.target.value))}>
            <option value="1">01 · Ler coils</option>
            <option value="2">02 · Ler entradas discretas</option>
            <option value="4">04 · Ler input registers</option>
            <option value="5">05 · Escrever coil (0/1)</option>
            <option value="15">15 · Escrever coils (0/1)</option>
            <option value="3">03 — Ler holding registers</option>
            <option value="6">06 — Escrever um registro</option>
            <option value="16">16 — Escrever múltiplos</option>
          </select>
        </label>
        <label>
          Unit ID
          <input
            name="unit"
            type="number"
            min={1}
            max={247}
            defaultValue={target?.modbus?.unit ?? 1}
            required
          />
        </label>
        <label>
          Endereço inicial
          <input name="address" type="number" min={0} max={65535} defaultValue={0} required />
        </label>
        <label>
          Quantidade
          <input
            name="quantity"
            type="number"
            min={1}
            max={
              [1, 2].includes(operation)
                ? 2000
                : operation === 15
                  ? 1968
                  : [5, 6].includes(operation)
                    ? 1
                    : operation === 16
                      ? 123
                      : 125
            }
            defaultValue={1}
            required
          />
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
