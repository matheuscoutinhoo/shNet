import { plcProcessConfig, plcProcessConfigSchema, hmiScanConfig, type Device } from '@shlab/engine';
import type { LabController } from './useLab';
const processFields = [
  ['scanMs', 'Ciclo PLC (ms)', 100, 10000, 100],
  ['initialLevel', 'Nível inicial ao aplicar (0–1000)', 0, 1000, 1],
  ['fillPerSecond', 'Vazão de entrada (unidades/s)', 0, 1000, 1],
  ['drainPerSecond', 'Vazão de saída (unidades/s)', 0, 1000, 1],
  ['lowAlarm', 'Alarme baixo do PLC', 0, 1000, 1],
  ['highAlarm', 'Alarme alto do PLC', 0, 1000, 1],
  ['hysteresis', 'Histerese do controle', 0, 100, 1],
  ['setpointRegister', 'Holding register do setpoint', 0, 1023, 1],
  ['levelInputRegister', 'Input register do nível', 0, 1023, 1],
  ['pumpCoil', 'Coil da bomba', 0, 1023, 1],
  ['alarmDiscreteInput', 'Entrada discreta do alarme', 0, 1023, 1],
] as const;
const scanFields = [
  ['port', 'Porta do ciclo HMI', 1, 65535, 1, 502],
  ['unit', 'Unit ID do ciclo HMI', 1, 247, 1, 1],
  ['address', 'Primeiro registrador do ciclo HMI', 0, 65535, 1, 0],
  ['quantity', 'Quantidade do ciclo HMI', 1, 125, 1, 1],
  ['intervalMs', 'Intervalo de leitura HMI (ms)', 100, 30000, 100, 1000],
  ['deadlineMs', 'Deadline da leitura HMI (ms)', 100, 30000, 100, 800],
  ['missedBeforeAlarm', 'Leituras perdidas para alarme', 1, 20, 1, 3],
] as const;
export function IndustrialProcessPanel({
  lab,
  plc,
  source,
}: {
  lab: LabController;
  plc: Device;
  source?: Device;
}) {
  const p = plc.plcProcess;
  const defaults = p ? plcProcessConfig(plc) : plcProcessConfigSchema.parse({ enabled: true });
  const h = source?.hmiScan;
  const hmi = h && source ? hmiScanConfig(source) : undefined;
  return (
    <section className="industrial-process-panel">
      <h3>Ciclo PLC e processo de tanque</h3>
      <p>
        Modelo de tanque com nível de 0 a 1000. O PLC lê o sensor, controla a bomba e publica os bancos Modbus
        a cada ciclo. A drenagem continua com o PLC desligado; a bomba fica desligada. Aplicar reinicia o
        nível informado. Este modelo não executa ladder, firmware ou funções de segurança de um PLC real.
      </p>
      {p && (
        <div role="status" aria-label="Estado do processo PLC">
          Nível: {(p.levelMilli / 1000).toFixed(1)}/1000 · Bomba: {p.lastPump ? 'ligada' : 'desligada'} ·
          Scans: {p.scans}
          <p>
            Alarme: {p.alarms.latched ? 'retido' : 'normal'} · Baixo: {String(p.alarms.low)} · Alto:{' '}
            {String(p.alarms.high)} · Setpoint inválido: {String(p.alarms.invalidSetpoint)} · Reconhecido:{' '}
            {String(p.alarms.acknowledged)}
          </p>
          <button
            className="button small"
            disabled={!p.alarms.latched}
            onClick={() => {
              const resume = lab.playing;
              const applied = lab.change((e) => {
                e.acknowledgeProcessAlarm(plc.id);
                return true;
              });
              if (applied && resume) lab.setPlaying(true);
            }}
          >
            Reconhecer alarme do processo
          </button>
        </div>
      )}
      <form
        key={plc.id + ':' + (p?.token ?? 'new')}
        onSubmit={(event) => {
          event.preventDefault();
          const f = new FormData(event.currentTarget);
          lab.change((e) =>
            e.configurePlcProcess(plc.id, {
              enabled: f.has('enabled'),
              control: f.get('control'),
              ...Object.fromEntries(processFields.map(([key]) => [key, Number(f.get(key))])),
            })
          );
        }}
      >
        <label className="check-label">
          <input name="enabled" type="checkbox" defaultChecked={defaults.enabled} />
          Processo habilitado
        </label>
        <label>
          Controle do tanque
          <select name="control" defaultValue={defaults.control}>
            <option value="automatic">Automático pelo setpoint</option>
            <option value="manual">Manual pela coil</option>
          </select>
        </label>
        <div className="form-grid">
          {processFields.map(([key, label, min, max, step]) => (
            <label key={key}>
              {label}
              <input
                name={key}
                type="number"
                required
                min={min}
                max={max}
                step={step}
                defaultValue={key === 'initialLevel' && p ? Math.round(p.levelMilli / 1000) : defaults[key]}
              />
            </label>
          ))}
        </div>
        <p className="muted">
          Setpoint, sensor, bomba e alarme usam os endereços dos bancos configurados acima. O controle
          automático aceita setpoint de 0 a 1000; valor maior gera alarme e desliga a bomba.
        </p>
        <button className="button primary" disabled={!plc.modbus}>
          Aplicar processo PLC
        </button>
      </form>
      {source && ['pc', 'server'].includes(source.type) && (
        <>
          <h3>Ciclo HMI / SCADA / MES — {source.hostname}</h3>
          <p>
            Leituras periódicas por Modbus TCP IPv4. O alarme de comunicação conta leituras consecutivas sem
            resposta válida. O último valor recebido permanece visível e pode ficar desatualizado.
          </p>
          {h && (
            <div role="status" aria-label="Estado do ciclo HMI">
              Valores: {h.values.length ? h.values.join(', ') : 'sem amostra'} · Amostras: {h.samples} ·
              Perdidas: {h.missed}
              <p>
                Comunicação:{' '}
                {!source.power
                  ? 'desligada'
                  : !h.enabled
                    ? 'pausada'
                    : h.communicationAlarm
                      ? 'alarme'
                      : h.samples
                        ? 'normal'
                        : 'aguardando leitura'}{' '}
                · Valor: {h.processAlarm ? 'alarme' : 'normal'} · Última recepção:{' '}
                {h.receivedAt === undefined ? 'nenhuma' : h.receivedAt.toFixed(1) + ' ms virtuais'} ·
                Latência: {h.latencyMs === undefined ? '—' : h.latencyMs.toFixed(3) + ' ms'} · Qualidade:{' '}
                {h.receivedAt === undefined ||
                !source.power ||
                lab.engine.state.clock - h.receivedAt > h.intervalMs + h.deadlineMs
                  ? 'desatualizada'
                  : 'atual'}
              </p>
              {h.lastError && <p>{h.lastError}</p>}
            </div>
          )}
          <form
            key={source.id + ':' + (h?.token ?? 'new')}
            onSubmit={(event) => {
              event.preventDefault();
              const f = new FormData(event.currentTarget);
              lab.change((e) =>
                e.configureHmiScan(source.id, {
                  enabled: f.has('enabled'),
                  target: String(f.get('target')),
                  function: Number(f.get('function')),
                  ...Object.fromEntries(scanFields.map(([key]) => [key, Number(f.get(key))])),
                  ...Object.fromEntries(
                    ['lowAlarm', 'highAlarm']
                      .filter((key) => String(f.get(key)).trim())
                      .map((key) => [key, Number(f.get(key))])
                  ),
                })
              );
            }}
          >
            <label className="check-label">
              <input name="enabled" type="checkbox" defaultChecked={h?.enabled ?? true} />
              Ciclo HMI habilitado
            </label>
            <label>
              Endereço do PLC para o ciclo HMI
              <input
                name="target"
                required
                defaultValue={h?.target ?? plc.interfaces.find((port) => port.ip)?.ip ?? ''}
              />
            </label>
            <label>
              Banco lido no ciclo HMI
              <select name="function" defaultValue={h?.function ?? 4}>
                <option value="4">04 — Input registers (sensor)</option>
                <option value="3">03 — Holding registers (setpoint)</option>
              </select>
            </label>
            <div className="form-grid">
              {scanFields.map(([key, label, min, max, step, fallback]) => (
                <label key={key}>
                  {label}
                  <input
                    name={key}
                    type="number"
                    required
                    min={min}
                    max={max}
                    step={step}
                    defaultValue={hmi?.[key] ?? fallback}
                  />
                </label>
              ))}
              <label>
                Alarme baixo da amostra HMI (opcional)
                <input name="lowAlarm" type="number" min="0" max="65535" defaultValue={h?.lowAlarm} />
              </label>
              <label>
                Alarme alto da amostra HMI (opcional)
                <input name="highAlarm" type="number" min="0" max="65535" defaultValue={h?.highAlarm} />
              </label>
            </div>
            <button className="button primary">Aplicar ciclo HMI</button>
          </form>
        </>
      )}
    </section>
  );
}
