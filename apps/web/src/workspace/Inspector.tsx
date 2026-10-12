import {
  deviceCapabilities,
  inspectorTabIds,
  deviceIntegrityIssues,
  devicePresentationProfile,
} from './deviceCapabilities';
import { ResizableInspector } from './ResizableInspector';
import { SectionEducation } from './SectionEducation';
import { devicePurpose } from './educationalContent';
import { InfrastructurePanel } from './InfrastructurePanel';
import { DatabasePanel } from './DatabasePanel';
import { AaaPanel } from './AaaPanel';
import { VxlanPanel } from './VxlanPanel';
import { ForwardingPanel } from './ForwardingPanel';
import { TunnelPanel, SdwanControllerPanel } from './TunnelPanel';
import { WirelessPanel } from './WirelessPanel';
import { Ipv6Panel } from './Ipv6Panel';
import { interfaceOperational } from '@shlab/engine';
import { Layer3Panel } from './Layer3Panel';
import { LacpPanel } from './LacpPanel';
import { BgpPanel } from './BgpPanel';
import { VrrpPanel } from './VrrpPanel';
import { useState, lazy, Suspense, type FormEvent } from 'react';
import {
  X,
  Power,
  TerminalSquare,
  Info,
  Network,
  Table2,
  ScrollText,
  ChevronRight,
  Settings2,
  Globe,
  GitBranch,
  ShieldCheck,
} from 'lucide-react';
import {
  catalog,
  deviceProfile,
  clearArpPending,
  interfaceSchema,
  ipv4Schema,
  resolveDefaultRoutes,
  ripRoutes,
  subnet,
  type Device,
  type NetworkInterface,
} from '@shlab/engine';
import { DeviceIcon } from '../components/DeviceIcon';
import { Modal } from '../components/Modal';
import { DhcpPanel } from './DhcpPanel';
import { DnsPanel } from './DnsPanel';
import { SpanningTreePanel } from './SpanningTreePanel';
import { PolicyPanel } from './PolicyPanel';
import { AdvancedNetworkPanel } from './AdvancedNetworkPanel';
import { HardwarePanel } from './HardwarePanel';
import { ApplicationsPanel } from './ApplicationsPanel';
import { TcpPanel } from './TcpPanel';
import { OspfPanel } from './OspfPanel';
import { RipPanel } from './RipPanel';
import { ManagementPanel } from './ManagementPanel';
const Terminal = lazy(() => import('./Terminal').then((m) => ({ default: m.Terminal })));
import type { LabController } from './useLab';
export function Inspector({
  lab,
  device,
  onClose,
  width,
  onWidth,
}: {
  lab: LabController;
  device: Device;
  onClose: () => void;
  width: number;
  onWidth: (width: number) => void;
}) {
  const [tab, setTab] = useState('overview'),
    [port, setPort] = useState<string | null>(null),
    [basic, setBasic] = useState(true);
  const presentation = devicePresentationProfile(device);
  const spec = presentation ?? catalog.find((c) => c.type === device.type)!;
  const capabilities = deviceCapabilities(device);
  const issues = deviceIntegrityIssues(device);
  const tabs = inspectorTabIds(device);
  const activeTab = tabs.includes(tab) ? tab : 'overview';
  const advancedName = capabilities.ap
    ? 'CAPWAP / Mesh / EAP'
    : capabilities.controller
      ? 'WLC / CAPWAP'
      : capabilities.advancedKinds.includes('ids')
        ? 'IDS / IPS'
        : 'EAP empresarial';
  return (
    <ResizableInspector width={width} onWidth={onWidth}>
      <div className="panel-heading">
        <span>INSPECIONAR EQUIPAMENTO</span>
        <button className="icon-button" onClick={onClose} aria-label="Fechar inspector">
          <X size={16} />
        </button>
      </div>
      <div className="inspector-device">
        <DeviceIcon profile={presentation?.id} type={device.type} size={48} />
        <div>
          <h2>{device.hostname}</h2>
          <span>{spec.model}</span>
        </div>
        {capabilities.power && (
          <button
            className={'power-button ' + (!device.power ? 'off' : '')}
            title={device.power ? 'Desligar equipamento' : 'Ligar equipamento'}
            aria-label={device.power ? 'Desligar equipamento' : 'Ligar equipamento'}
            disabled={device.infrastructure?.kind === 'patch-panel'}
            onClick={() =>
              lab.change(() => {
                lab.engine.setDevicePower(device.id, !device.power);
                lab.engine.emit(
                  device.power ? 'LINK_UP' : 'LINK_DOWN',
                  device.id,
                  device.power ? 'Equipamento ligado' : 'Equipamento desligado'
                );
              })
            }
          >
            <Power size={17} />
          </button>
        )}
      </div>
      <div className="inspector-tabs" aria-label="Recursos do equipamento">
        {[
          { id: 'overview', name: 'Resumo', icon: Info },
          { id: 'interfaces', name: 'Portas', icon: Network },
          { id: 'lacp', name: 'LACP', icon: Network },
          { id: 'layer3', name: capabilities.vrf ? 'VLAN / VRF' : 'VLAN / SVI', icon: Network },
          { id: 'cli', name: 'Terminal', icon: TerminalSquare },
          { id: 'tables', name: 'Tabelas', icon: Table2 },
          { id: 'aaa', name: '802.1X / AAA', icon: ShieldCheck },
          { id: 'ipv6', name: 'IPv6', icon: Globe },
          { id: 'forwarding', name: device.type === 'router' ? 'QoS / MPLS' : 'QoS', icon: Network },
          { id: 'vxlan', name: 'VXLAN / EVPN', icon: Network },
          { id: 'tunnels', name: 'VPN / SD-WAN', icon: Network },
          { id: 'sdwanController', name: 'Controller WAN', icon: Settings2 },
          { id: 'wireless', name: 'Wireless', icon: Network },
          { id: 'advancedNetwork', name: advancedName, icon: ShieldCheck },
          { id: 'hardware', name: 'Hardware / PoE', icon: Settings2 },
          {
            id: 'infrastructure',
            name: device.infrastructure ? 'Infraestrutura' : 'Recursos físicos',
            icon: Settings2,
          },
          { id: 'database', name: 'Banco de dados', icon: Table2 },
          { id: 'applications', name: 'Aplicações', icon: Globe },
          { id: 'dhcp', name: 'DHCP', icon: Settings2 },
          { id: 'dns', name: 'DNS', icon: Globe },
          { id: 'tcp', name: 'TCP / HTTP', icon: Globe },
          { id: 'stp', name: 'STP', icon: GitBranch },
          { id: 'ospf', name: 'OSPF', icon: GitBranch },
          { id: 'rip', name: 'RIP', icon: GitBranch },
          { id: 'vrrp', name: 'VRRP', icon: GitBranch },
          { id: 'bgp', name: 'BGP', icon: GitBranch },
          { id: 'policy', name: 'Políticas', icon: ShieldCheck },
          { id: 'management', name: 'Gerenciamento', icon: Settings2 },
          { id: 'logs', name: 'Logs', icon: ScrollText },
        ]
          .filter((t) => tabs.includes(t.id))
          .map((t) => (
            <button
              key={t.id}
              className={activeTab === t.id ? 'active' : ''}
              title={t.name}
              aria-pressed={activeTab === t.id}
              onClick={() => setTab(t.id)}
            >
              <t.icon size={16} />
              <span>{t.name}</span>
            </button>
          ))}
      </div>
      <div className={'inspector-body ' + (activeTab === 'cli' ? 'terminal-body' : '')}>
        <h3 className="sr-only">Configuração e estado de {device.hostname}</h3>
        <SectionEducation section={activeTab} device={device} />
        {activeTab === 'overview' && (
          <>
            {issues.length > 0 && (
              <section className="device-integrity-notice" aria-label="Revisão do perfil">
                <h4>Revisão do perfil</h4>
                <ul>
                  {issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </section>
            )}
            <div className="mode-switch">
              <span>Modo educacional</span>
              <button
                role="switch"
                aria-checked={basic}
                aria-label="Modo educacional"
                className={'switch ' + (basic ? 'on' : '')}
                onClick={() => setBasic(!basic)}
              >
                <i />
              </button>
            </div>
            {basic && (
              <div className="learning-card">
                <span>
                  <Info size={16} /> O que este equipamento faz?
                </span>
                <p>{devicePurpose(device)}</p>
              </div>
            )}
            <form
              onSubmit={(e: FormEvent<HTMLFormElement>) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                lab.change(() => {
                  const name = String(f.get('hostname'));
                  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(name)) throw new Error('Hostname inválido');
                  device.hostname = name;
                  if (capabilities.endpoint) {
                    const gateway = String(f.get('gateway') ?? '').trim();
                    if (gateway) device.gateway = ipv4Schema.parse(gateway);
                    else delete device.gateway;
                  }
                });
              }}
            >
              <label>
                Hostname
                <input
                  name="hostname"
                  defaultValue={device.hostname}
                  key={device.hostname}
                  maxLength={32}
                  required
                />
              </label>
              {capabilities.endpoint && (
                <label>
                  Gateway estático
                  <input
                    name="gateway"
                    defaultValue={device.gateway ?? ''}
                    key={device.gateway}
                    placeholder="192.168.10.1"
                  />
                </label>
              )}
              <button className="button small" type="submit">
                Aplicar configuração
              </button>
            </form>
            <h4 className="small-heading">ESTADO DO EQUIPAMENTO</h4>
            <dl className="key-values">
              <div>
                <dt>Estado</dt>
                <dd className={device.power ? 'good' : 'muted'}>
                  {capabilities.power ? (device.power ? '● Ligado' : '○ Desligado') : 'Passivo'}
                </dd>
              </div>
              <div>
                <dt>Fabricante / função</dt>
                <dd>shLab · {deviceProfile(device)?.role ?? spec.name}</dd>
              </div>
              <div>
                <dt>Camada</dt>
                <dd>{spec.layer}</dd>
              </div>
              <div>
                <dt>Interfaces</dt>
                <dd>{device.interfaces.length}</dd>
              </div>
              <div>
                <dt>Recebidos / enviados</dt>
                <dd>
                  {device.interfaces.reduce((n, p) => n + p.rx, 0)} /{' '}
                  {device.interfaces.reduce((n, p) => n + p.tx, 0)}
                </dd>
              </div>
              <div>
                <dt>Descartes</dt>
                <dd>{device.dropped}</dd>
              </div>
              <div>
                <dt>Tempo simulado</dt>
                <dd>{lab.engine.state.clock.toFixed(2)} ms</dd>
              </div>
            </dl>
            {device.interfaces
              .filter((p) => p.ip)
              .map((p) => (
                <div className="subnet-card" key={p.id}>
                  <span>
                    {p.name} · {p.ip}/{p.prefix}
                  </span>
                  <dl className="key-values">
                    <div>
                      <dt>Rede</dt>
                      <dd>{subnet(p.ip!, p.prefix!).network}</dd>
                    </div>
                    <div>
                      <dt>Broadcast</dt>
                      <dd>{subnet(p.ip!, p.prefix!).broadcast}</dd>
                    </div>
                  </dl>
                </div>
              ))}
            <button className="button terminal-shortcut" onClick={() => setTab('cli')}>
              <TerminalSquare size={17} /> Abrir terminal NetOS <ChevronRight size={16} />
            </button>
          </>
        )}
        {activeTab === 'interfaces' && (
          <>
            <p className="muted panel-description">
              Cada interface tem seu próprio endereço, estado e configuração.
            </p>
            <div className="interface-list">
              {device.interfaces.map((p) => {
                const connected = interfaceOperational(lab.engine.state, device, p);
                return (
                  <button className="interface-item" key={p.id} onClick={() => setPort(p.id)}>
                    <span className={'status-dot ' + (!connected ? 'down' : '')} />
                    <div>
                      <strong>{p.name}</strong>
                      <small>
                        {p.ip
                          ? p.ip + '/' + p.prefix
                          : p.mode === 'routed'
                            ? 'Sem endereço IPv4'
                            : p.mode + ' · VLAN ' + p.accessVlan}
                      </small>
                    </div>
                    <span>
                      {!p.adminUp ? 'shutdown' : connected ? 'up' : 'down'}
                      <Settings2 size={13} />
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}
        {activeTab === 'infrastructure' && <InfrastructurePanel lab={lab} device={device} />}
        {activeTab === 'database' && <DatabasePanel lab={lab} device={device} />}
        {activeTab === 'cli' && (
          <>
            <Suspense fallback={<p className="muted">Carregando terminal…</p>}>
              <Terminal lab={lab} deviceId={device.id} />
            </Suspense>
            <div className="terminal-help">
              <kbd>help</kbd> Comandos disponíveis <span>·</span> <kbd>↑ ↓</kbd> Histórico
            </div>
          </>
        )}
        {activeTab === 'tables' && (
          <>
            {(capabilities.switching || capabilities.ap || capabilities.controller) && (
              <Table
                title="Tabela MAC"
                headers={['VLAN', 'MAC', 'Porta']}
                rows={device.macTable.map((m) => [
                  String(m.vlan),
                  m.mac,
                  device.interfaces.find((i) => i.id === m.port)?.name ?? m.port,
                ])}
              />
            )}
            <Table
              title="Cache ARP"
              headers={['IPv4', 'MAC', 'Porta']}
              rows={device.arpTable.map((a) => [
                a.ip,
                a.mac,
                device.interfaces.find((i) => i.id === a.port)?.name ?? a.port,
              ])}
            />
            <Table
              title="Resoluções ARP"
              headers={['IPv4', 'Porta', 'Tentativa', 'Próximo evento']}
              rows={(device.arpResolutions ?? []).map((entry) => [
                entry.ip,
                device.interfaces.find((port) => port.id === entry.port)?.name ?? entry.port,
                entry.attempts + '/3',
                Math.max(0, entry.nextAt - lab.engine.state.clock).toFixed(1) + ' ms',
              ])}
            />
            <Table
              title="Rotas IPv4"
              headers={['Tipo', 'Destino', 'Próximo salto']}
              rows={[
                ...device.interfaces
                  .filter((i) => i.ip && i.adminUp)
                  .map((i) => [
                    'C',
                    subnet(i.ip!, i.prefix!).network + '/' + i.prefix,
                    i.name + (i.vrf ? ' · VRF ' + i.vrf : ''),
                  ]),
                ...device.routes.map((r) => [
                  'S',
                  r.network + '/' + r.prefix,
                  r.nextHop + (r.vrf ? ' · VRF ' + r.vrf : ''),
                ]),
                ...(device.ospf?.routes ?? []).map((r) => [
                  r.pathType === 'inter' ? 'O IA' : 'O',
                  r.network + '/' + r.prefix,
                  `${r.nextHop} [110/${r.metric}]`,
                ]),
                ...ripRoutes(device).map((r) => [
                  'R',
                  `${r.network}/${r.prefix}`,
                  `${r.nextHop} [120/${r.metric}]`,
                ]),
                ...(device.bgp?.routes ?? []).map((r) => [
                  'B',
                  `${r.network}/${r.prefix}`,
                  `${r.nextHop} [${r.distance}/${r.metric}]`,
                ]),
                ...resolveDefaultRoutes(device).map((route) => [
                  route.port.ipv4Mode === 'dhcp' ? 'DHCP' : 'S',
                  '0.0.0.0/0',
                  route.nextHop,
                ]),
              ]}
            />
            {capabilities.layer3 && (
              <Table
                title="VLANs"
                headers={['ID', 'Nome']}
                rows={device.vlans.map((v) => [String(v.id), v.name])}
              />
            )}
            <p className="muted">Use o terminal para criar VLANs, configurar trunks e rotas estáticas.</p>
          </>
        )}
        {activeTab === 'layer3' && <Layer3Panel key={device.id} lab={lab} device={device} />}
        {activeTab === 'wireless' && <WirelessPanel key={device.id} lab={lab} device={device} />}
        {activeTab === 'tunnels' && <TunnelPanel key={device.id} lab={lab} device={device} />}
        {activeTab === 'sdwanController' && (
          <SdwanControllerPanel key={device.id} lab={lab} device={device} />
        )}
        {activeTab === 'vxlan' && <VxlanPanel key={device.id} lab={lab} device={device} />}
        {activeTab === 'forwarding' && <ForwardingPanel key={device.id} lab={lab} device={device} />}
        {activeTab === 'aaa' && <AaaPanel lab={lab} device={device} />}
        {activeTab === 'ipv6' && <Ipv6Panel key={device.id} lab={lab} device={device} />}
        {activeTab === 'lacp' && <LacpPanel key={device.id} lab={lab} device={device} />}
        {activeTab === 'dhcp' && <DhcpPanel lab={lab} device={device} />}
        {activeTab === 'dns' && <DnsPanel lab={lab} device={device} />}
        {activeTab === 'advancedNetwork' && (
          <AdvancedNetworkPanel key={device.id} lab={lab} device={device} />
        )}
        {activeTab === 'hardware' && <HardwarePanel key={device.id} lab={lab} device={device} />}
        {activeTab === 'applications' && <ApplicationsPanel key={device.id} lab={lab} device={device} />}
        {activeTab === 'tcp' && <TcpPanel key={device.id} lab={lab} device={device} />}
        {activeTab === 'ospf' && <OspfPanel key={device.id} lab={lab} device={device} />}
        {activeTab === 'rip' && <RipPanel key={device.id} lab={lab} device={device} />}
        {activeTab === 'vrrp' && <VrrpPanel key={device.id} lab={lab} device={device} />}
        {activeTab === 'bgp' && <BgpPanel key={device.id} lab={lab} device={device} />}
        {activeTab === 'management' && <ManagementPanel key={device.id} lab={lab} device={device} />}
        {activeTab === 'stp' && <SpanningTreePanel lab={lab} device={device} />}
        {activeTab === 'policy' && <PolicyPanel lab={lab} device={device} />}
        {activeTab === 'logs' && (
          <div className="device-logs">
            {device.logs.length ? (
              device.logs
                .slice()
                .reverse()
                .map((l, i) => <pre key={i}>{l}</pre>)
            ) : (
              <p className="muted">Nenhum evento neste equipamento.</p>
            )}
          </div>
        )}
      </div>
      {port && (
        <PortEditor
          lab={lab}
          device={device}
          port={device.interfaces.find((p) => p.id === port)!}
          onClose={() => setPort(null)}
        />
      )}
    </ResizableInspector>
  );
}
function Table({ title, headers, rows }: { title: string; headers: string[]; rows: string[][] }) {
  return (
    <section className="table-section">
      <h4>
        {title}
        <span>{rows.length}</span>
      </h4>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {headers.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((v, j) => (
                  <td key={j}>{v}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && <p className="table-empty">Nenhuma entrada. Gere tráfego para observar o estado.</p>}
    </section>
  );
}
function PortEditor({
  lab,
  device,
  port,
  onClose,
}: {
  lab: LabController;
  device: Device;
  port: NetworkInterface;
  onClose: () => void;
}) {
  const layer3 = device.type !== 'switch' || ['routed', 'svi'].includes(port.mode);
  const [error, setError] = useState('');
  const [addressMode, setAddressMode] = useState(port.ipv4Mode ?? 'static');
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    lab.setError('');
    const f = new FormData(e.currentTarget);
    try {
      const automatic =
        layer3 &&
        !port.logical &&
        !port.tunnel &&
        !port.vrf &&
        device.type !== 'switch' &&
        addressMode === 'dhcp';
      const ip = String(f.get('ip') ?? '').trim(),
        prefix = Number(f.get('prefix') ?? 24);
      const parsed = interfaceSchema.parse({
        ...port,
        adminUp: f.get('adminUp') === 'on',
        description: String(f.get('description')),
        mtu: Number(f.get('mtu')),
        speed: port.media === 'wifi' ? port.speed : Number(f.get('speed')),
        ...(['sfp', 'qsfp'].includes(port.media)
          ? { transceiver: String(f.get('transceiver')) || undefined }
          : {}),
        ...(!layer3
          ? {
              mode: f.get('mode'),
              accessVlan: Number(f.get('accessVlan')),
              nativeVlan: Number(f.get('nativeVlan')),
              allowedVlans: String(f.get('allowedVlans')).split(',').filter(Boolean).map(Number),
              stpEdge: f.get('stpEdge') === 'on',
              stpCost: String(f.get('stpCost') ?? '').trim() ? Number(f.get('stpCost')) : undefined,
            }
          : automatic
            ? {}
            : { ip: ip || undefined, prefix: ip ? prefix : undefined }),
      });
      if (!automatic && ip && prefix < 31) {
        const net = subnet(ip, prefix);
        if (ip === net.network || ip === net.broadcast) throw new Error('Use um endereço de host válido');
      }
      if (
        !automatic &&
        ip &&
        lab.engine.state.devices.some((d) =>
          d.interfaces.some(
            (p) => p.ip === ip && p.vrf === port.vrf && (d.id !== device.id || p.id !== port.id)
          )
        )
      )
        throw new Error('IP já utilizado');
      const result = lab.change(() => {
        const resetTree =
          device.spanningTree?.enabled &&
          (port.stpEdge !== parsed.stpEdge || port.stpCost !== parsed.stpCost || port.speed !== parsed.speed);
        if (!automatic && port.dhcp) {
          lab.engine.disableDhcp(device.id, port.id);
          delete parsed.dhcp;
          delete parsed.gateway;
          delete parsed.dns;
          parsed.ipv4Mode = 'static';
        }
        Object.assign(port, parsed);
        if (resetTree) lab.engine.rebuildSpanningTree(device.id);
        device.arpTable = [];
        device.macTable = [];
        clearArpPending(lab.engine, device);
        if (automatic && (!port.dhcp || ['released', 'failed'].includes(port.dhcp.status)))
          lab.engine.requestDhcp(device.id, port.id);
        lab.engine.emit('CONFIG_CHANGED', device.id, 'Configuração de ' + port.name + ' atualizada.', {
          port: port.id,
        });
        return true;
      });
      if (result) onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (device.infrastructure || ['serial', 'console', 'mesh'].includes(port.media))
    return (
      <Modal title={device.hostname + ' · ' + port.name} onClose={onClose}>
        <dl className="key-values">
          <div>
            <dt>Mídia</dt>
            <dd>{port.media.toUpperCase()}</dd>
          </div>
          <div>
            <dt>Estado</dt>
            <dd>{port.adminUp ? 'Habilitada' : 'Desabilitada'}</dd>
          </div>
        </dl>
        <p>
          {device.infrastructure?.kind === 'patch-panel'
            ? 'Porta passiva: o jumper apenas passa o sinal. Configure os pares na aba Infraestrutura; endereços IP e VLANs pertencem aos equipamentos conectados.'
            : 'Esta porta não recebe endereços IP nesta tela. Configure serial ou console na aba Hardware / PoE.'}
        </p>
      </Modal>
    );
  return (
    <Modal title={device.hostname + ' · ' + port.name} onClose={onClose}>
      <form onSubmit={submit}>
        <label className="checkbox-label">
          <input type="checkbox" name="adminUp" defaultChecked={port.adminUp} /> Interface habilitada (no
          shutdown)
        </label>
        <label>
          Descrição
          <input name="description" defaultValue={port.description} maxLength={160} />
        </label>
        {layer3 ? (
          <>
            <fieldset className="ipv4-mode">
              <legend>Endereçamento IPv4</legend>
              <label>
                <input
                  type="radio"
                  name="ipv4Mode"
                  value="static"
                  checked={addressMode === 'static'}
                  onChange={() => setAddressMode('static')}
                />{' '}
                Estático
              </label>
              <label>
                <input
                  type="radio"
                  name="ipv4Mode"
                  value="dhcp"
                  checked={addressMode === 'dhcp'}
                  onChange={() => setAddressMode('dhcp')}
                  disabled={
                    !!port.logical ||
                    !!port.tunnel ||
                    !!port.vrf ||
                    device.type === 'switch' ||
                    device.dhcpServer?.pools.some((pool) => pool.port === port.id)
                  }
                />{' '}
                Automático (DHCP)
              </label>
            </fieldset>
            <div className="form-grid">
              <label>
                Endereço IPv4
                <input
                  name="ip"
                  defaultValue={port.ip ?? ''}
                  placeholder="192.168.10.10"
                  disabled={addressMode === 'dhcp'}
                />
              </label>
              <label>
                Prefixo CIDR
                <input
                  name="prefix"
                  type="number"
                  min="0"
                  max="32"
                  defaultValue={port.prefix ?? 24}
                  disabled={addressMode === 'dhcp'}
                />
              </label>
            </div>
          </>
        ) : (
          <>
            <div className="form-grid">
              <label>
                Modo
                <select name="mode" defaultValue={port.mode}>
                  <option value="access">Access</option>
                  <option value="trunk">Trunk</option>
                </select>
              </label>
              <label>
                Access VLAN
                <input name="accessVlan" type="number" min="1" max="4094" defaultValue={port.accessVlan} />
              </label>
            </div>
            <div className="form-grid">
              <label>
                Native VLAN
                <input name="nativeVlan" type="number" min="1" max="4094" defaultValue={port.nativeVlan} />
              </label>
              <label>
                VLANs permitidas
                <input name="allowedVlans" defaultValue={port.allowedVlans.join(',')} placeholder="1,10,20" />
              </label>
            </div>
            <p className="muted">Crie as VLANs no terminal antes de encaminhar tráfego.</p>
          </>
        )}
        <div className="form-grid">
          {port.media !== 'wifi' && (
            <label>
              Velocidade
              <select name="speed" defaultValue={port.speed}>
                <option value="100">100 Mbps</option>
                <option value="1000">1 Gbps</option>
                <option value="10000">10 Gbps</option>
                {port.media === 'qsfp' && (
                  <>
                    <option value="40000">40 Gbps</option>
                    <option value="100000">100 Gbps</option>
                  </>
                )}
              </select>
            </label>
          )}
          <label>
            MTU
            <input type="number" name="mtu" min="576" max="9216" defaultValue={port.mtu} />
          </label>
        </div>
        {['sfp', 'qsfp'].includes(port.media) && (
          <label>
            Módulo transceiver
            <select name="transceiver" defaultValue={port.transceiver ?? ''}>
              <option value="">Sem módulo</option>
              <option value="single-mode">Monomodo</option>
              <option value="multi-mode">Multimodo</option>
              <option value="dac">DAC</option>
            </select>
          </label>
        )}
        <p className="muted">
          Mídia: {port.media.toUpperCase()}
          {port.transceiver ? ' · ' + port.transceiver : ''} · MAC: {port.mac}
        </p>
        {deviceCapabilities(device).switching && !port.logical && port.mode !== 'routed' && (
          <div className="form-grid">
            <label>
              Custo STP
              <input
                name="stpCost"
                type="number"
                min="1"
                max="200000000"
                defaultValue={port.stpCost ?? ''}
                placeholder="Automático"
              />
            </label>
            <label className="checkbox-label">
              <input name="stpEdge" type="checkbox" defaultChecked={port.stpEdge ?? false} /> Porta edge
              (PortFast)
            </label>
          </div>
        )}
        {(error || lab.error) && (
          <div className="alert error" role="alert">
            {error || lab.error}
          </div>
        )}
        <button className="button primary">Aplicar à simulação</button>
      </form>
    </Modal>
  );
}
