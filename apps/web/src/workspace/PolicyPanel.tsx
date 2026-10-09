import { useState, type FormEvent } from 'react';
import { Plus, Pencil, Trash2, Save } from 'lucide-react';
import { aclRuleSchema, type AclRule, type Device, type NatConfig } from '@shlab/engine';
import { Modal } from '../components/Modal';
import type { LabController } from './useLab';
import { FirewallPanel } from './FirewallPanel';

const network = (value: string) => {
  if (value.trim().toLowerCase() === 'any') return { network: '0.0.0.0', prefix: 0 };
  const [address, prefix = '32'] = value.trim().split('/');
  return { network: address, prefix: Number(prefix) };
};
const baseNat = (device: Device): NatConfig =>
  device.nat ?? { enabled: true, statics: [], pools: [], bindings: [] };
export function PolicyPanel({ lab, device }: { lab: LabController; device: Device }) {
  const [rule, setRule] = useState<{ name: string; value?: AclRule } | null>(null);
  const [natEditor, setNatEditor] = useState(false);
  return (
    <div className="policy-panel">
      {device.type === 'router' && <FirewallPanel lab={lab} device={device} />}
      <div className="policy-heading">
        <h4>Access lists</h4>
        <button className="button small" onClick={() => setRule({ name: 'FILTER' })}>
          <Plus size={14} /> Nova regra
        </button>
      </div>
      {device.accessLists?.map((acl) => (
        <section className="table-section" key={acl.name}>
          <div className="policy-heading">
            <h4>{acl.name}</h4>
            <button
              className="icon-button"
              title="Excluir ACL"
              aria-label={'Excluir ACL ' + acl.name}
              onClick={() => lab.change((engine) => engine.removeAcl(device.id, acl.name))}
            >
              <Trash2 size={14} />
            </button>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Regra</th>
                  <th>Filtro</th>
                  <th>Hits</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {acl.rules.map((entry) => (
                  <tr key={entry.sequence}>
                    <td>
                      {entry.sequence}
                      <br />
                      {entry.action}
                    </td>
                    <td>
                      {entry.protocol.toUpperCase()}
                      <br />
                      <small>
                        {entry.source.network}/{entry.source.prefix}
                        <br />
                        {entry.destination.network}/{entry.destination.prefix}
                        {entry.destinationPort ? ':' + entry.destinationPort : ''}
                      </small>
                    </td>
                    <td>{entry.hits}</td>
                    <td>
                      <button
                        className="icon-button"
                        title="Editar regra"
                        aria-label={'Editar regra ' + entry.sequence + ' de ' + acl.name}
                        onClick={() => setRule({ name: acl.name, value: entry })}
                      >
                        <Pencil size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">Deny implícito: {acl.implicitDrops}</p>
        </section>
      ))}
      <h4>Interfaces</h4>
      {device.interfaces
        .filter((port) => port.mode === 'routed')
        .map((port) => (
          <section className="policy-interface" key={port.id}>
            <strong>{port.name}</strong>
            <div className="form-grid">
              {(['in', 'out'] as const).map((direction) => (
                <label key={direction}>
                  {direction === 'in' ? 'Entrada' : 'Saída'}
                  <select
                    aria-label={'ACL ' + direction + ' ' + port.name}
                    value={(direction === 'in' ? port.aclIn : port.aclOut) ?? ''}
                    onChange={(event) =>
                      lab.change((engine) =>
                        engine.bindAcl(device.id, port.id, direction, event.target.value || undefined)
                      )
                    }
                  >
                    <option value="">Nenhuma</option>
                    {device.accessLists?.map((acl) => (
                      <option key={acl.name}>{acl.name}</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            {device.type === 'router' && (
              <label>
                Papel NAT
                <select
                  aria-label={'Papel NAT ' + port.name}
                  value={port.natRole ?? ''}
                  onChange={(event) =>
                    lab.change(() => {
                      if (event.target.value) port.natRole = event.target.value as 'inside' | 'outside';
                      else delete port.natRole;
                    })
                  }
                >
                  <option value="">Nenhum</option>
                  <option value="inside">Inside</option>
                  <option value="outside">Outside</option>
                </select>
              </label>
            )}
          </section>
        ))}
      {device.type === 'router' && (
        <>
          <div className="policy-heading">
            <h4>NAT</h4>
            <button
              className="button small"
              disabled={!device.interfaces.some((port) => port.natRole === 'outside')}
              onClick={() => setNatEditor(true)}
            >
              <Plus size={14} /> Nova tradução
            </button>
          </div>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={device.nat?.enabled ?? false}
              onChange={(event) =>
                lab.change((engine) =>
                  engine.configureNat(device.id, { ...baseNat(device), enabled: event.target.checked })
                )
              }
            />{' '}
            NAT habilitado
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={device.nat?.hairpin ?? false}
              onChange={(event) =>
                lab.change((engine) =>
                  engine.configureNat(device.id, { ...baseNat(device), hairpin: event.target.checked })
                )
              }
            />
            Hairpin: acessar o IP global a partir das LANs inside
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={device.nat?.algSip ?? false}
              onChange={(ev) =>
                lab.change((e) =>
                  e.configureNat(device.id, { ...baseNat(device), algSip: ev.target.checked })
                )
              }
            />
            ALG SIP / SDP e mídia RTP
          </label>
          {device.nat?.sipBindings?.map((b) => (
            <p key={b.id}>
              SIP {b.call}: mídia {b.inside}:{b.insidePort} ↔ {b.global}:{b.globalPort} ↔ {b.remote}:
              {b.remoteMedia ?? 'aguardando SDP'}
            </p>
          ))}
          {device.nat?.hairpins?.map((b) => (
            <p key={b.id}>
              {b.protocol} hairpin {b.client}:{b.clientToken} → {b.vip} → {b.server}; retorno via {b.snat}:
              {b.mappedToken}
            </p>
          ))}
          {device.nat?.statics.map((entry) => (
            <div className="policy-heading" key={entry.inside}>
              <span>
                {entry.inside} → {entry.global}
              </span>
              <button
                className="icon-button"
                title="Remover tradução estática"
                aria-label={'Remover NAT ' + entry.inside}
                onClick={() =>
                  lab.change((engine) =>
                    engine.configureNat(device.id, {
                      ...baseNat(device),
                      statics: device.nat!.statics.filter((item) => item !== entry),
                    })
                  )
                }
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          {device.nat?.pools.map((pool) => (
            <div className="policy-heading" key={pool.name}>
              <span>
                {pool.name} · {pool.overload ? 'PAT' : 'Dynamic'}
                <br />
                <small>
                  {pool.start} → {pool.end}
                </small>
              </span>
              <button
                className="icon-button"
                title="Remover pool NAT"
                aria-label={'Remover pool NAT ' + pool.name}
                onClick={() =>
                  lab.change((engine) =>
                    engine.configureNat(device.id, {
                      ...baseNat(device),
                      pools: device.nat!.pools.filter((item) => item !== pool),
                    })
                  )
                }
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <section className="table-section nat-translations">
            <h4>
              Traduções ativas <span>{device.nat?.bindings.length ?? 0}</span>
            </h4>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Inside local</th>
                    <th>Inside global</th>
                  </tr>
                </thead>
                <tbody>
                  {device.nat?.bindings.map((entry) => (
                    <tr key={entry.id}>
                      <td>
                        {entry.inside}
                        <br />
                        <small>{entry.insideToken ?? entry.protocol}</small>
                      </td>
                      <td>
                        {entry.global}
                        <br />
                        <small>{entry.globalToken ?? entry.protocol}</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
      {rule && <RuleEditor lab={lab} device={device} initial={rule} onClose={() => setRule(null)} />}
      {natEditor && <NatEditor lab={lab} device={device} onClose={() => setNatEditor(false)} />}
    </div>
  );
}

function RuleEditor({
  lab,
  device,
  initial,
  onClose,
}: {
  lab: LabController;
  device: Device;
  initial: { name: string; value?: AclRule };
  onClose: () => void;
}) {
  const [error, setError] = useState('');
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    lab.setError('');
    const data = new FormData(event.currentTarget);
    try {
      const name = String(data.get('name'));
      const parsed = aclRuleSchema.parse({
        sequence: Number(data.get('sequence')),
        action: data.get('action'),
        protocol: data.get('protocol'),
        source: network(String(data.get('source'))),
        destination: network(String(data.get('destination'))),
        destinationPort: String(data.get('port') ?? '').trim() ? Number(data.get('port')) : undefined,
      });
      const existing = device.accessLists?.find((acl) => acl.name === name);
      if (
        lab.change((engine) =>
          engine.configureAcl(device.id, {
            name,
            rules: [
              ...(existing?.rules.filter((entry) => entry.sequence !== initial.value?.sequence) ?? []),
              parsed,
            ],
          })
        )
      )
        onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Regra inválida.');
    }
  }
  return (
    <Modal title="Regra ACL" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>
            Nome da ACL
            <input
              name="name"
              defaultValue={initial.name}
              readOnly={!!initial.value}
              maxLength={32}
              required
            />
          </label>
          <label>
            Sequência
            <input
              name="sequence"
              type="number"
              min="1"
              max="65535"
              defaultValue={initial.value?.sequence ?? 10}
              required
            />
          </label>
        </div>
        <div className="form-grid">
          <label>
            Ação
            <select name="action" defaultValue={initial.value?.action ?? 'permit'}>
              <option>permit</option>
              <option>deny</option>
            </select>
          </label>
          <label>
            Protocolo
            <select name="protocol" defaultValue={initial.value?.protocol ?? 'ip'}>
              <option>ip</option>
              <option>icmp</option>
              <option>udp</option>
              <option>tcp</option>
              <option>ospf</option>
              <option>vrrp</option>
            </select>
          </label>
        </div>
        <label>
          Origem CIDR
          <input
            name="source"
            defaultValue={
              initial.value ? initial.value.source.network + '/' + initial.value.source.prefix : 'any'
            }
            required
          />
        </label>
        <label>
          Destino CIDR
          <input
            name="destination"
            defaultValue={
              initial.value
                ? initial.value.destination.network + '/' + initial.value.destination.prefix
                : 'any'
            }
            required
          />
        </label>
        <label>
          Porta UDP/TCP de destino
          <input
            name="port"
            type="number"
            min="1"
            max="65535"
            defaultValue={initial.value?.destinationPort ?? ''}
          />
        </label>
        {(error || lab.error) && (
          <div className="alert error" role="alert">
            {error || lab.error}
          </div>
        )}
        <button className="button primary">
          <Save size={15} /> Salvar regra
        </button>
      </form>
    </Modal>
  );
}
function NatEditor({ lab, device, onClose }: { lab: LabController; device: Device; onClose: () => void }) {
  const [mode, setMode] = useState('pat');
  const [error, setError] = useState('');
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    lab.setError('');
    const data = new FormData(event.currentTarget);
    try {
      const config = structuredClone(baseNat(device));
      config.enabled = true;
      if (mode === 'static')
        config.statics.push({
          inside: String(data.get('source')),
          global: String(data.get('start')),
          outside: String(data.get('outside')),
        });
      else
        config.pools.push({
          name: String(data.get('name')),
          source: network(String(data.get('source'))),
          outside: String(data.get('outside')),
          start: String(data.get('start')),
          end: String(data.get('end')),
          overload: mode === 'pat',
        });
      if (lab.change((engine) => engine.configureNat(device.id, config))) onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Configuração inválida.');
    }
  }
  return (
    <Modal title="Tradução NAT" onClose={onClose}>
      <form onSubmit={submit}>
        <label>
          Modo de tradução
          <select value={mode} onChange={(event) => setMode(event.target.value)}>
            <option value="static">Static</option>
            <option value="dynamic">Dynamic</option>
            <option value="pat">PAT</option>
          </select>
        </label>
        <label>
          Interface outside
          <select name="outside">
            {device.interfaces
              .filter((port) => port.natRole === 'outside')
              .map((port) => (
                <option key={port.id} value={port.id}>
                  {port.name} · {port.ip}
                </option>
              ))}
          </select>
        </label>
        {mode !== 'static' && (
          <label>
            Nome do pool NAT
            <input name="name" defaultValue="WAN" required maxLength={32} />
          </label>
        )}
        <label>
          {mode === 'static' ? 'Endereço inside local' : 'Rede interna CIDR'}
          <input
            name="source"
            defaultValue={mode === 'static' ? '192.168.10.10' : '192.168.10.0/24'}
            key={mode}
            required
          />
        </label>
        <label>
          Endereço global inicial
          <input name="start" defaultValue="192.168.20.100" required />
        </label>
        {mode !== 'static' && (
          <label>
            Endereço global final
            <input name="end" defaultValue="192.168.20.100" required />
          </label>
        )}
        {(error || lab.error) && (
          <div className="alert error" role="alert">
            {error || lab.error}
          </div>
        )}
        <button className="button primary">
          <Save size={15} /> Salvar tradução
        </button>
      </form>
    </Modal>
  );
}
