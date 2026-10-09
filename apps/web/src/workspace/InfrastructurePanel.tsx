import { useState } from 'react';
import type { Device } from '@shlab/engine';
import type { LabController } from './useLab';
export function InfrastructurePanel({ lab, device }: { lab: LabController; device: Device }) {
  const c = device.infrastructure;
  const [entries, setEntries] = useState(() => (c?.kind === 'rack' ? c.slots.map((s) => ({ ...s })) : []));
  const [loads, setLoads] = useState(() => (c?.kind === 'ups' ? c.loads.map((l) => ({ ...l })) : []));
  const [pairs, setPairs] = useState(() => (c?.kind === 'patch-panel' ? c.pairs.map((p) => ({ ...p })) : []));
  const others = lab.engine.state.devices.filter((d) => d.id !== device.id);
  return (
    <section className="infrastructure-panel">
      <h4>Infraestrutura e capacidade</h4>
      {c?.kind === 'rack' && (
        <form
          onSubmit={(ev) => {
            ev.preventDefault();
            const f = new FormData(ev.currentTarget);
            lab.change((e) =>
              e.configureInfrastructure(device.id, {
                ...c,
                units: Number(f.get('units')),
                ambientC: Number(f.get('ambient')),
                ventilation: Number(f.get('ventilation')),
                slots: entries,
              })
            );
          }}
        >
          <label>
            Altura (U)
            <input name="units" type="number" min={1} max={60} defaultValue={c.units} />
          </label>
          <label>
            Ambiente (°C)
            <input name="ambient" type="number" min={-20} max={60} defaultValue={c.ambientC} />
          </label>
          <label>
            Ventilação (0–1)
            <input name="ventilation" type="number" min={0} max={1} step={0.1} defaultValue={c.ventilation} />
          </label>
          <h4>Equipamentos montados</h4>
          {entries.map((s, i) => (
            <fieldset key={i}>
              <legend>Posição {i + 1}</legend>
              <label>
                Equipamento
                <select
                  value={s.device}
                  onChange={(ev) =>
                    setEntries(entries.map((v, n) => (n === i ? { ...v, device: ev.target.value } : v)))
                  }
                >
                  {others
                    .filter((d) => d.infrastructure?.kind !== 'rack')
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.hostname}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Primeira U
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={s.unit}
                  onChange={(ev) =>
                    setEntries(entries.map((v, n) => (n === i ? { ...v, unit: Number(ev.target.value) } : v)))
                  }
                />
              </label>
              <label>
                Altura ocupada (U)
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={s.units}
                  onChange={(ev) =>
                    setEntries(
                      entries.map((v, n) => (n === i ? { ...v, units: Number(ev.target.value) } : v))
                    )
                  }
                />
              </label>
              <button
                type="button"
                className="button small"
                onClick={() => setEntries(entries.filter((_, n) => n !== i))}
              >
                Remover posição {i + 1}
              </button>
            </fieldset>
          ))}
          <button
            type="button"
            className="button small"
            disabled={!others.length || entries.length >= 60}
            onClick={() => {
              const d = others.find((d) => d.infrastructure?.kind !== 'rack');
              if (d) setEntries([...entries, { device: d.id, unit: entries.length + 1, units: 1 }]);
            }}
          >
            Montar equipamento
          </button>
          <button className="button small primary">Aplicar rack</button>
        </form>
      )}
      {c?.kind === 'patch-panel' && (
        <form
          onSubmit={(ev) => {
            ev.preventDefault();
            lab.change((e) => e.configureInfrastructure(device.id, { kind: 'patch-panel', pairs }));
          }}
        >
          <p className="muted">Cada jumper une duas portas sem aprender MAC ou remover tags VLAN.</p>
          {pairs.map((p, i) => (
            <fieldset key={i}>
              <legend>Jumper {i + 1}</legend>
              {(['a', 'b'] as const).map((side) => (
                <label key={side}>
                  Porta {side.toUpperCase()}
                  <select
                    value={p[side]}
                    onChange={(ev) =>
                      setPairs(pairs.map((v, n) => (n === i ? { ...v, [side]: ev.target.value } : v)))
                    }
                  >
                    {device.interfaces.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <button
                type="button"
                className="button small"
                onClick={() => setPairs(pairs.filter((_, n) => n !== i))}
              >
                Remover jumper {i + 1}
              </button>
            </fieldset>
          ))}
          <button
            type="button"
            className="button small"
            disabled={pairs.length >= 24}
            onClick={() => setPairs([...pairs, { a: device.interfaces[0].id, b: device.interfaces[1].id }])}
          >
            Adicionar jumper
          </button>
          <button className="button small primary">Aplicar patch panel</button>
        </form>
      )}
      {c?.kind === 'ups' && (
        <form
          onSubmit={(ev) => {
            ev.preventDefault();
            const f = new FormData(ev.currentTarget);
            const capacityWh = Number(f.get('capacity'));
            lab.change((e) =>
              e.configureInfrastructure(device.id, {
                ...c,
                mains: f.get('mains') === 'on',
                capacityWh,
                remainingWh: Math.min(c.remainingWh, capacityWh),
                lastAt: e.state.clock,
                maxWatts: Number(f.get('max')),
                chargeWatts: Number(f.get('charge')),
                efficiency: Number(f.get('efficiency')),
                loads,
              })
            );
          }}
        >
          <p role="status">
            Bateria: {c.remainingWh.toFixed(2)}/{c.capacityWh} Wh · Saída {c.output ? 'ligada' : 'desligada'}{' '}
            · {c.loads.filter((l) => l.requested).reduce((n, l) => n + l.watts, 0)} W
          </p>
          <label>
            <input name="mains" type="checkbox" defaultChecked={c.mains} />
            Rede elétrica disponível
          </label>
          <label>
            Capacidade (Wh)
            <input name="capacity" type="number" min={1} max={100000} defaultValue={c.capacityWh} />
          </label>
          <label>
            Potência máxima (W)
            <input name="max" type="number" min={0} max={10000} defaultValue={c.maxWatts} />
          </label>
          <label>
            Recarga (W)
            <input name="charge" type="number" min={0} max={10000} defaultValue={c.chargeWatts} />
          </label>
          <label>
            Eficiência (0,1–1)
            <input
              name="efficiency"
              type="number"
              min={0.1}
              max={1}
              step={0.01}
              defaultValue={c.efficiency}
            />
          </label>
          {loads.map((l, i) => (
            <fieldset key={i}>
              <legend>Carga {i + 1}</legend>
              <label>
                Equipamento
                <select
                  value={l.device}
                  onChange={(ev) =>
                    setLoads(loads.map((v, n) => (n === i ? { ...v, device: ev.target.value } : v)))
                  }
                >
                  {others
                    .filter((d) => d.infrastructure?.kind !== 'ups' && !d.poeDevice?.required)
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.hostname}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Consumo (W)
                <input
                  type="number"
                  min={0}
                  max={10000}
                  value={l.watts}
                  onChange={(ev) =>
                    setLoads(loads.map((v, n) => (n === i ? { ...v, watts: Number(ev.target.value) } : v)))
                  }
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={l.requested}
                  onChange={(ev) =>
                    setLoads(loads.map((v, n) => (n === i ? { ...v, requested: ev.target.checked } : v)))
                  }
                />
                Carga solicitada
              </label>
              <button
                type="button"
                className="button small"
                onClick={() => setLoads(loads.filter((_, n) => n !== i))}
              >
                Remover carga {i + 1}
              </button>
            </fieldset>
          ))}
          <button
            type="button"
            className="button small"
            disabled={loads.length >= 64}
            onClick={() => {
              const d = others.find((d) => d.infrastructure?.kind !== 'ups' && !d.poeDevice?.required);
              if (d) setLoads([...loads, { device: d.id, watts: 100, requested: true }]);
            }}
          >
            Adicionar carga
          </button>
          <button className="button small primary">Aplicar UPS</button>
        </form>
      )}
      {!c && (
        <form
          onSubmit={(ev) => {
            ev.preventDefault();
            const f = new FormData(ev.currentTarget);
            lab.change((e) =>
              e.configureSystem(device.id, {
                enabled: f.get('enabled') === 'on',
                capacityPps: Number(f.get('pps')),
                memoryLimitKiB: Number(f.get('memory')),
                ambientC: Number(f.get('ambient')),
                thermalLimitC: Number(f.get('thermal')),
              })
            );
          }}
        >
          <p className="muted">
            A capacidade limita a fila de processamento; memória é estimada pelo estado e buffers. Temperatura
            depende do ambiente, rack e utilização. Não são medições do computador real.
          </p>
          <label>
            <input name="enabled" type="checkbox" defaultChecked={device.system?.enabled ?? true} />
            Modelar recursos
          </label>
          <label>
            Capacidade (pacotes/s)
            <input
              name="pps"
              type="number"
              min={1}
              max={10000000}
              defaultValue={device.system?.capacityPps ?? 100000}
            />
          </label>
          <label>
            Memória (KiB)
            <input
              name="memory"
              type="number"
              min={64}
              max={1048576}
              defaultValue={device.system?.memoryLimitKiB ?? 65536}
            />
          </label>
          <label>
            Ambiente (°C)
            <input
              name="ambient"
              type="number"
              min={-20}
              max={60}
              defaultValue={device.system?.ambientC ?? 22}
            />
          </label>
          <label>
            Limite térmico (°C)
            <input
              name="thermal"
              type="number"
              min={40}
              max={120}
              defaultValue={device.system?.thermalLimitC ?? 85}
            />
          </label>
          <button className="button small primary">Aplicar capacidade</button>
        </form>
      )}
      {device.system && (
        <p role="status">
          CPU {device.system.cpuPercent.toFixed(1)}% · Memória {device.system.memoryKiB}/
          {device.system.memoryLimitKiB} KiB · {device.system.temperatureC.toFixed(1)} °C ·{' '}
          {device.system.processed} pacotes ·{' '}
          {device.system.throttled ? 'limitação térmica' : 'capacidade normal'}
        </p>
      )}
    </section>
  );
}
