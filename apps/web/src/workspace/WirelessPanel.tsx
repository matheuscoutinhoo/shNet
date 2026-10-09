import { useState } from 'react';
import { wirelessConfig, wirelessMetrics, type Device } from '@shlab/engine';
import type { LabController } from './useLab';

export function WirelessPanel({ lab, device }: { lab: LabController; device: Device }) {
  const c = wirelessConfig(device),
    [band, setBand] = useState(c.band),
    [security, setSecurity] = useState(c.security);
  const links = lab.engine.state.links.filter(
    (l) => l.cable === 'wireless' && [l.a, l.b].some((p) => p.device === device.id)
  );
  return (
    <div className="wireless-panel">
      <p className="muted">
        Associação e troca de mensagens habilitam o transporte pelo rádio. WPA2-PSK/WPA3-SAE usam provas de
        credencial do modelo. WPA2-Enterprise usa EAP, certificados, TLS e AES-GCM; configure cliente e
        autenticador no painel WLC / Mesh / IDS. Posições no canvas usam escala de 4 px por metro.
      </p>
      <form
        key={device.id}
        onSubmit={(event) => {
          event.preventDefault();
          const f = new FormData(event.currentTarget);
          lab.change((e) =>
            e.configureWireless(device.id, {
              role: device.type === 'switch' ? 'ap' : 'client',
              ssid: String(f.get('ssid')),
              security,
              ...(security === 'open' || security === 'wpa2-enterprise' ? {} : { key: String(f.get('key')) }),
              band,
              channel: Number(f.get('channel')),
              txPower: Number(f.get('power')),
              noise: Number(f.get('noise')),
              attenuation: Number(f.get('attenuation')),
              enabled: f.get('enabled') === 'on',
            })
          );
        }}
      >
        <strong>{device.type === 'switch' ? 'Access point / bridge' : 'Cliente wireless'}</strong>
        <label className="wireless-check">
          <input type="checkbox" name="enabled" defaultChecked={c.enabled} />
          Rádio habilitado
        </label>
        <label>
          SSID
          <input aria-label="SSID wireless" name="ssid" maxLength={32} defaultValue={c.ssid} required />
        </label>
        <label>
          Segurança wireless
          <select
            aria-label="Segurança wireless"
            value={security}
            onChange={(e) => setSecurity(e.target.value as typeof security)}
          >
            <option value="open">Aberta</option>
            <option value="wpa2-enterprise">WPA2-Enterprise (EAP TLS / PEAP)</option>
            <option value="wpa2-psk">WPA2-PSK (conceitual)</option>
            <option value="wpa3-sae">WPA3-SAE (conceitual)</option>
          </select>
        </label>
        {security !== 'open' && security !== 'wpa2-enterprise' && (
          <label>
            Chave do SSID
            <input
              aria-label="Chave do SSID"
              type="password"
              name="key"
              minLength={8}
              maxLength={63}
              defaultValue={c.key ?? ''}
              required
              autoComplete="off"
            />
          </label>
        )}
        <div className="wireless-grid">
          <label>
            Banda
            <select
              aria-label="Banda wireless"
              value={band}
              onChange={(e) => setBand(e.target.value as typeof band)}
            >
              <option value="2.4">2.4 GHz</option>
              <option value="5">5 GHz</option>
            </select>
          </label>
          <label>
            Canal
            <select
              aria-label="Canal wireless"
              name="channel"
              key={band}
              defaultValue={band === c.band ? c.channel : band === '2.4' ? 1 : 36}
            >
              {(band === '2.4'
                ? Array.from({ length: 11 }, (_, i) => i + 1)
                : [36, 40, 44, 48, 149, 153, 157, 161, 165]
              ).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="wireless-grid">
          <label>
            Potência (dBm)
            <input name="power" type="number" min={0} max={30} defaultValue={c.txPower} />
          </label>
          <label>
            Ruído (dBm)
            <input name="noise" type="number" min={-110} max={-30} defaultValue={c.noise} />
          </label>
        </div>
        <label>
          Atenuação de obstáculos (dB)
          <input
            aria-label="Atenuação de obstáculos"
            name="attenuation"
            type="number"
            min={0}
            max={40}
            defaultValue={c.attenuation}
          />
        </label>
        <button className="button primary">Aplicar wireless</button>
      </form>
      <section className="wireless-state" aria-live="polite">
        <h3>Estado do rádio</h3>
        <strong>{device.wireless?.phase ?? 'não configurado'}</strong>
        <p>
          {device.wireless?.association
            ? 'BSSID ' + device.wireless.association.bssid
            : 'Sem associação de cliente'}
        </p>
        <p className="muted">
          Enderece Wlan0 na aba Portas, ou use DHCP nessa interface. No AP, access VLAN em Wlan0 associa o
          SSID à VLAN da bridge. O cliente usa o canal escolhido; altere-o junto com o AP.
        </p>
      </section>
      <section>
        <h3>Enlaces e sinal</h3>
        {links.map((l) => {
          const m = wirelessMetrics(lab.engine.state, l),
            other = lab.engine.device(l.a.device === device.id ? l.b.device : l.a.device);
          return (
            <article className="wireless-link" key={l.id}>
              <strong>{other.hostname}</strong>
              <span>
                {m.distance.toFixed(1)} m · RSSI {m.rssi.toFixed(1)} dBm
              </span>
              <span>
                SNR {m.snr.toFixed(1)} dB · interferência {m.interference.toFixed(1)} dB
              </span>
              <span>
                Perda {(m.loss * 100).toFixed(1)}% ·{' '}
                {m.operational ? 'rádio alcançável' : 'sem alcance/canal'}
              </span>
            </article>
          );
        })}
      </section>
      {device.wireless?.role === 'ap' ? (
        <section>
          <h3>Clientes ({device.wireless.peers.length})</h3>
          {device.wireless.peers.map((p) => (
            <p key={p.mac}>
              <code>{p.mac}</code> · {p.phase}
            </p>
          ))}
        </section>
      ) : (
        <section>
          <h3>APs descobertos</h3>
          {device.wireless?.seen.map((p) => (
            <article className="wireless-link" key={p.bssid}>
              <strong>{p.ssid}</strong>
              <code>{p.bssid}</code>
              <span>
                {p.security} · {p.signal.toFixed(1)} dBm
              </span>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
