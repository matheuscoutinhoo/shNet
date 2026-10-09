import { CommentDialog } from './CommentDialog';
import { LearningPanel, TutorialPanel } from './LearningPanel';
import { NetworkConceptGuide } from './NetworkConceptGuide';
import { wirelessConfig, qosConfig, remoteConfig } from '@shlab/engine';
import { CaptureDialog } from './CaptureDialog';
import { useEffect, useRef, useState } from 'react';
import type { Connection } from '@xyflow/react';
import {
  ArrowLeft,
  BookOpen,
  Cable,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileJson,
  FolderClock,
  HelpCircle,
  LayoutPanelLeft,
  MousePointer2,
  Network,
  Pause,
  Play,
  Plus,
  Redo2,
  Save,
  Search,
  Send,
  SkipForward,
  SlidersHorizontal,
  Trash2,
  Undo2,
  Upload,
  X,
  AlignHorizontalJustifyCenter,
  StickyNote,
  Group,
  Ungroup,
  Square,
} from 'lucide-react';
import {
  deviceProfiles,
  addCanvasItem,
  groupDevices,
  removeCanvasItem,
  type CanvasItem,
  type Device,
  type Link,
  type Snapshot,
} from '@shlab/engine';
import { api, download, type Project, type User } from '../api';
import { Brand } from '../components/Brand';
import { DeviceIcon } from '../components/DeviceIcon';
import { Modal } from '../components/Modal';
import { useLab, type LabController } from './useLab';
import { TopologyCanvas } from './TopologyCanvas';
import { LabPanel } from './LabPanel';
import { NetworkInspector } from './NetworkInspector';
import { Inspector } from './Inspector';
import { Timeline } from './Timeline';
import { ConnectDialog, LinkDialog } from './Connections';
export function Workspace({
  project,
  user,
  onClose,
  onExpired,
}: {
  project: Project;
  user: User;
  onClose: () => void;
  onExpired: () => void;
}) {
  const lab = useLab(project, onExpired),
    [selected, setSelected] = useState<string[]>([]),
    [query, setQuery] = useState(''),
    [catalogQuery, setCatalogQuery] = useState(''),
    [detailed, setDetailed] = useState(true),
    [showCatalog, setShowCatalog] = useState(true),
    [connect, setConnect] = useState<Connection | true | null>(null),
    [link, setLink] = useState<string | null>(null),
    [ping, setPing] = useState(false),
    [pingSource, setPingSource] = useState(''),
    [help, setHelp] = useState(false),
    [showTasks, setShowTasks] = useState(false),
    [showChallenge, setShowChallenge] = useState(false),
    [showTutorial, setShowTutorial] = useState(false),
    [showNetwork, setShowNetwork] = useState(false),
    [snapshots, setSnapshots] = useState(false),
    [highlight, setHighlight] = useState<number | undefined>(),
    [more, setMore] = useState(false),
    [drawing, setDrawing] = useState(false),
    [comment, setComment] = useState(false),
    [capture, setCapture] = useState(false),
    [mode, setMode] = useState<'simulation' | 'realtime'>('simulation');
  const importRef = useRef<HTMLInputElement>(null),
    copyRef = useRef<Device[]>([]);
  const copiedItems = useRef<CanvasItem[]>([]);
  const copiedLinks = useRef<Link[]>([]);
  const device = lab.engine.state.devices.find((d) => d.id === selected[0]);
  const duplicate = () =>
    lab.change((e) => {
      const originals = copyRef.current.length
        ? copyRef.current
        : e.state.devices.filter(
            (d) =>
              selected.includes(d.id) ||
              e.state.canvasItems?.some((item) => selected.includes(item.id) && item.members?.includes(d.id))
          );
      const mapping = new Map<string, string>();
      const created = originals.map((d) => {
        const copy = e.addDevice(d.type, { x: d.position.x + 50, y: d.position.y + 80 });
        copy.profile = d.profile;
        copy.hostname = d.hostname.slice(0, 24) + '-copy';
        copy.ipRouting = d.ipRouting;
        copy.ipv6Routing = d.ipv6Routing;
        if (d.wireless) e.configureWireless(copy.id, wirelessConfig(d));
        copy.vrfs = structuredClone(d.vrfs);
        const physical = copy.interfaces;
        const portMapping = new Map(
          d.interfaces.map((p, i) => [
            p.id,
            p.logical
              ? e.id('interface')
              : p.aggregate || p.tunnel || p.vxlan
                ? p.id
                : (physical[i]?.id ?? p.id),
          ])
        );
        copy.interfaces = d.interfaces.map((p, i) => ({
          ...structuredClone(p),
          id: portMapping.get(p.id)!,
          mac: p.aggregate
            ? physical[0].mac.split(':').slice(0, 4).join(':') +
              ':02:' +
              p.aggregate.number.toString(16).padStart(2, '0')
            : p.vxlan
              ? physical[0].mac.split(':').slice(0, 4).join(':') + ':05:' + i.toString(16).padStart(2, '0')
              : p.tunnel
                ? physical[0].mac.split(':').slice(0, 4).join(':') +
                  ':04:' +
                  p.tunnel.number.toString(16).padStart(2, '0')
                : p.logical
                  ? physical[0].mac.split(':').slice(0, 4).join(':') +
                    ':01:' +
                    i.toString(16).padStart(2, '0')
                  : (physical[i]?.mac ?? physical[0].mac.slice(0, -2) + i.toString(16).padStart(2, '0')),
          ...(p.logical
            ? {
                logical: {
                  ...p.logical,
                  ...(p.logical.parent ? { parent: portMapping.get(p.logical.parent)! } : {}),
                },
              }
            : {}),
          rx: 0,
          tx: 0,
          errors: 0,
        }));
        copy.interfaces.forEach((p) => {
          if (p.dot1x) p.accessVlan = p.dot1x.baseVlan;
          delete p.dot1x;
          delete p.supplicant;
          delete p.ip;
          delete p.prefix;
          delete p.gateway;
          delete p.dns;
          delete p.dhcp;
          delete p.dhcpRelay;
          delete p.spanningTree;
          delete p.spanningInstances;
          delete p.mstBoundary;
          delete p.ipv6;
          delete p.dhcp6;
          if (p.qos) {
            const c = qosConfig(p);
            delete p.qos;
            e.configureQos(copy.id, p.id, c);
          }
          if (p.vxlan)
            p.vxlan = {
              ...p.vxlan,
              enabled: false,
              underlay: portMapping.get(p.vxlan.underlay)!,
              local: [],
              routes: [],
              learned: [],
              sent: 0,
              received: 0,
            };
          if (p.tunnel) {
            p.ip = p.tunnel.ip;
            p.prefix = p.tunnel.prefix;
            p.tunnel = {
              ...p.tunnel,
              enabled: false,
              underlay: portMapping.get(p.tunnel.underlay)!,
              status: 'down',
              token: e.id('tunnel'),
              tickAt: e.state.clock + 0.001,
              samples: [],
              remotePrefixes: [],
              txSequence: 0,
              receivedSequences: [],
              sent: 0,
              received: 0,
              lastRx: undefined,
              peerNonce: undefined,
              peerEndpoint: undefined,
              pending: undefined,
            };
            e.schedule(0.001, { kind: 'tunnel-tick', device: copy.id, port: p.id, token: p.tunnel.token });
          }
          if (p.aggregate) {
            p.aggregate = {
              ...p.aggregate,
              members: p.aggregate.members.map((id) => portMapping.get(id)!),
              received: [],
              selected: [],
              token: e.id('lacp'),
              tickAt: e.state.clock + 0.001,
            };
            e.schedule(0.001, { kind: 'lacp-tick', device: copy.id, port: p.id, token: p.aggregate.token });
          }
          if (p.ipv4Mode === 'dhcp') e.requestDhcp(copy.id, p.id);
        });
        copy.vlans = structuredClone(d.vlans);
        copy.routes = structuredClone(d.routes);
        if (d.accessLists)
          copy.accessLists = structuredClone(d.accessLists).map((acl) => ({
            ...acl,
            implicitDrops: 0,
            rules: acl.rules.map((rule) => ({ ...rule, hits: 0 })),
          }));
        if (d.dnsServer) copy.dnsServer = structuredClone(d.dnsServer);
        if (d.tcpServices) copy.tcpServices = structuredClone(d.tcpServices);
        if (d.udp6Services) copy.udp6Services = structuredClone(d.udp6Services);
        if (d.firewall) {
          copy.firewall = { ...structuredClone(d.firewall), sessions: [], dropped: 0 };
          if (copy.firewall.application) copy.firewall.application.flows = [];
          copy.firewall.trustedPorts = copy.firewall.trustedPorts.map((p) => portMapping.get(p)!);
          if (copy.firewall.zonePolicy)
            copy.firewall.zonePolicy.zones.forEach((zone) => {
              zone.ports = zone.ports.map((p) => portMapping.get(p)!);
            });
        }
        if (d.remoteManagement) e.configureRemote(copy.id, remoteConfig(d));
        if (d.networkClock) e.configureClock(copy.id, structuredClone(d.networkClock));
        if (d.telemetryCollector)
          e.configureCollector(copy.id, {
            enabled: d.telemetryCollector.enabled,
            key: d.telemetryCollector.key,
          });
        if (d.snmpAgent) copy.snmpAgent = { ...structuredClone(d.snmpAgent), startedAt: e.state.clock };
        if (d.syslogClient) copy.syslogClient = structuredClone(d.syslogClient);
        if (d.syslogServer) copy.syslogServer = { enabled: d.syslogServer.enabled, entries: [] };
        if (d.multiSpanningTree)
          e.configureMultiSpanningTree(copy.id, {
            mode: d.multiSpanningTree.mode,
            region: d.multiSpanningTree.region,
            revision: d.multiSpanningTree.revision,
            priorities: d.multiSpanningTree.priorities,
            mappings: d.multiSpanningTree.mappings,
          });
        else if (d.spanningTree?.enabled)
          e.configureSpanningTree(copy.id, d.spanningTree.mode, d.spanningTree.priority);
        mapping.set(d.id, copy.id);
        return copy.id;
      });
      const annotations = copiedItems.current.length
        ? copiedItems.current
        : (e.state.canvasItems?.filter((item) => selected.includes(item.id)) ?? []);
      const internalLinks = copyRef.current.length
        ? copiedLinks.current
        : e.state.links.filter((link) => mapping.has(link.a.device) && mapping.has(link.b.device));
      for (const link of internalLinks.filter((l) => l.cable !== 'wireless'))
        e.connect(
          { device: mapping.get(link.a.device)!, port: link.a.port },
          { device: mapping.get(link.b.device)!, port: link.b.port },
          link.cable,
          { latency: link.latency, jitter: link.jitter, loss: link.loss, distance: link.distance }
        ).up = link.up;
      for (const original of originals) e.device(mapping.get(original.id)!).power = original.power;
      const createdItems = annotations.map(
        (item) =>
          addCanvasItem(e, {
            kind: item.kind,
            text: item.text,
            color: item.color,
            width: item.width,
            height: item.height,
            position: { x: item.position.x + 50, y: item.position.y + 80 },
            ...(item.points ? { points: structuredClone(item.points) } : {}),
            ...(item.anchor
              ? {
                  anchor: {
                    ...item.anchor,
                    target:
                      item.anchor.kind === 'device'
                        ? (mapping.get(item.anchor.target) ?? item.anchor.target)
                        : item.anchor.target,
                  },
                }
              : {}),
            ...(item.members
              ? {
                  members: item.members.flatMap((member) =>
                    mapping.has(member) ? [mapping.get(member)!] : []
                  ),
                }
              : {}),
          }).id
      );
      setSelected(createdItems.length ? createdItems : created);
    });
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void lab.save().catch(() => {});
        return;
      }
      if ((e.target as HTMLElement).closest('input,textarea,select,.xterm')) return;
      if (e.ctrlKey || e.metaKey) {
        if (e.key.toLowerCase() === 'z') {
          e.preventDefault();
          lab.history(e.shiftKey ? 'redo' : 'undo');
        }
        if (e.key.toLowerCase() === 'c') {
          e.preventDefault();
          copiedItems.current = structuredClone(
            lab.engine.state.canvasItems?.filter((item) => selected.includes(item.id)) ?? []
          );
          copyRef.current = structuredClone(
            lab.engine.state.devices.filter(
              (d) =>
                selected.includes(d.id) || copiedItems.current.some((item) => item.members?.includes(d.id))
            )
          );
          const ids = new Set(copyRef.current.map((entry) => entry.id));
          copiedLinks.current = structuredClone(
            lab.engine.state.links.filter((link) => ids.has(link.a.device) && ids.has(link.b.device))
          );
        }
        if (e.key.toLowerCase() === 'v') {
          e.preventDefault();
          duplicate();
        }
        if (e.key.toLowerCase() === 'd') {
          e.preventDefault();
          copyRef.current = [];
          copiedItems.current = [];
          copiedLinks.current = [];
          duplicate();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });
  async function leave() {
    lab.setPlaying(false);
    try {
      await lab.save();
      onClose();
    } catch {
      /* Preserve unsaved work in the open workspace. */
    }
  }
  const lastProbe = lab.engine.state.probes.at(-1);
  return (
    <div className="workspace">
      <header className="workspace-header">
        <button
          className="icon-button back-button"
          onClick={() => void leave()}
          aria-label="Voltar aos laboratórios"
        >
          <ArrowLeft size={19} />
        </button>
        <Brand />
        <span className="header-divider" />
        <div className="project-title">
          <input
            aria-label="Nome do laboratório"
            value={lab.name}
            maxLength={100}
            onChange={(e) => lab.setName(e.target.value)}
          />
          <span>
            <span className="status-dot" /> Laboratório privado <span>·</span> {lab.saveStatus}
          </span>
        </div>
        <div className="workspace-header-actions">
          <button
            aria-label="Salvar"
            className="button header-save"
            onClick={() => void lab.save().catch(() => {})}
          >
            <Save size={16} />
            <span>Salvar</span>
          </button>
          {project.lab_id && (
            <button
              className="icon-button"
              title="Tarefas do laboratório"
              aria-label="Tarefas do laboratório"
              onClick={() => setShowTasks(true)}
            >
              <BookOpen size={20} />
            </button>
          )}
          <button
            className="icon-button"
            title="Inspetor da rede"
            aria-label="Inspetor da rede"
            onClick={() => setShowNetwork(true)}
          >
            <Network size={20} />
          </button>
          <button className="icon-button" title="Ajuda" aria-label="Ajuda" onClick={() => setHelp(true)}>
            <HelpCircle size={20} />
          </button>
          <span className="avatar">{user.name.slice(0, 2).toUpperCase()}</span>
        </div>
      </header>
      <div className="workspace-toolbar">
        <div className="tool-group">
          <button
            className={'icon-button ' + (showCatalog ? 'chosen' : '')}
            title="Catálogo de equipamentos"
            aria-label="Mostrar catálogo"
            onClick={() => setShowCatalog(!showCatalog)}
          >
            <LayoutPanelLeft size={17} />
          </button>
          <span className="tool-separator" />
          <button
            className="icon-button"
            disabled={!lab.canUndo}
            title="Desfazer (Ctrl+Z)"
            aria-label="Desfazer"
            onClick={() => lab.history('undo')}
          >
            <Undo2 size={17} />
          </button>
          <button
            className="icon-button"
            disabled={!lab.canRedo}
            title="Refazer (Ctrl+Shift+Z)"
            aria-label="Refazer"
            onClick={() => lab.history('redo')}
          >
            <Redo2 size={17} />
          </button>
          <button
            className="icon-button"
            disabled={!selected.length}
            title="Duplicar (Ctrl+D)"
            aria-label="Duplicar"
            onClick={() => {
              copyRef.current = [];
              copiedItems.current = [];
              copiedLinks.current = [];
              duplicate();
            }}
          >
            <Copy size={17} />
          </button>
          <button
            className="icon-button"
            disabled={!selected.length}
            title="Excluir seleção"
            aria-label="Excluir seleção"
            onClick={() => {
              lab.change((e) => selected.forEach((id) => removeCanvasItem(e, id)));
              setSelected([]);
            }}
          >
            <Trash2 size={17} />
          </button>
          {selected.length > 1 && (
            <button
              className="icon-button"
              title="Alinhar horizontalmente"
              onClick={() =>
                lab.change((e) => {
                  const y = e.device(selected[0]).position.y;
                  selected.forEach((id) => {
                    e.device(id).position.y = y;
                  });
                })
              }
            >
              <AlignHorizontalJustifyCenter size={17} />
            </button>
          )}
          <span className="tool-separator" />
          <button className="tool-label" onClick={() => setConnect(true)}>
            <Cable size={17} /> Conectar
          </button>
        </div>
        <div className="simulation-controls">
          <select
            aria-label="Modo de simulação"
            value={mode}
            onChange={(e) => {
              const mode = e.target.value as 'simulation' | 'realtime';
              setMode(mode);
              lab.setPlaying(mode === 'realtime');
            }}
          >
            <option value="simulation">Simulação</option>
            <option value="realtime">Tempo real</option>
          </select>
          <button
            className={'play-button ' + (lab.playing ? 'playing' : '')}
            onClick={() => lab.setPlaying(!lab.playing)}
            title={lab.playing ? 'Pausar' : 'Executar'}
            aria-label={lab.playing ? 'Pausar simulação' : 'Executar simulação'}
          >
            {lab.playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <button
            className="icon-button"
            title="Próximo evento"
            aria-label="Próximo evento"
            disabled={!lab.engine.state.queue.length}
            onClick={() => {
              lab.setPlaying(false);
              lab.change((e) => e.step(), false);
            }}
          >
            <SkipForward size={17} />
          </button>
          <select
            className="speed-select"
            aria-label="Velocidade"
            value={lab.speed}
            onChange={(e) => lab.setSpeed(Number(e.target.value))}
          >
            {[0.25, 0.5, 1, 2, 5].map((n) => (
              <option key={n} value={n}>
                {n}×
              </option>
            ))}
          </select>
          <span className="pending-events">{lab.engine.state.queue.length} na fila</span>
        </div>
        <div className="tool-group">
          <button
            className="button small primary"
            onClick={() => {
              setPingSource(
                device?.id ??
                  lab.engine.state.devices.find(
                    (d) => d.type !== 'switch' || d.interfaces.some((p) => p.logical?.kind === 'svi')
                  )?.id ??
                  ''
              );
              setPing(true);
            }}
            disabled={
              !lab.engine.state.devices.some(
                (d) => d.type !== 'switch' || d.interfaces.some((p) => p.logical?.kind === 'svi')
              )
            }
          >
            <Send size={14} /> Enviar ping
          </button>
          <button className="tool-label" onClick={() => setShowChallenge(true)}>
            <BookOpen size={16} /> Desafio
          </button>
          <button className="tool-label" onClick={() => setShowTutorial(!showTutorial)}>
            <HelpCircle size={16} /> Tutorial
          </button>
          <div className="more-wrapper">
            <button
              className="icon-button"
              aria-label="Opções do laboratório"
              title="Opções do laboratório"
              onClick={() => setMore(!more)}
            >
              <SlidersHorizontal size={17} />
              <ChevronDown size={12} />
            </button>
            {more && (
              <div className="dropdown">
                <button
                  onClick={() => {
                    setCapture(true);
                    setMore(false);
                  }}
                >
                  <Download size={16} /> Exportar captura PCAP
                </button>
                <button
                  onClick={() => {
                    download(lab.name, lab.engine.snapshot());
                    setMore(false);
                  }}
                >
                  <Download size={16} /> Exportar topologia
                </button>
                <button
                  onClick={() => {
                    importRef.current?.click();
                    setMore(false);
                  }}
                >
                  <Upload size={16} /> Importar topologia
                </button>
                <button
                  onClick={() => {
                    setSnapshots(true);
                    setMore(false);
                  }}
                >
                  <FolderClock size={16} /> Snapshots
                </button>
                <label>
                  Fundo
                  <select
                    value={lab.engine.state.background}
                    onChange={(e) =>
                      lab.change((sim) => {
                        sim.state.background = e.target.value as Snapshot['background'];
                      })
                    }
                  >
                    <option value="light">Claro</option>
                    <option value="gray">Cinza</option>
                    <option value="dark">Escuro</option>
                  </select>
                </label>
                <label>
                  Marcação
                  <select
                    value={lab.engine.state.pattern}
                    onChange={(e) =>
                      lab.change((sim) => {
                        sim.state.pattern = e.target.value as Snapshot['pattern'];
                      })
                    }
                  >
                    <option value="dots">Pontos</option>
                    <option value="grid">Grade</option>
                    <option value="fine-grid">Grade fina</option>
                    <option value="none">Sem marcação</option>
                  </select>
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={lab.engine.state.snapToGrid ?? true}
                    onChange={(event) =>
                      lab.change((engine) => {
                        engine.state.snapToGrid = event.target.checked;
                      })
                    }
                  />{' '}
                  Ajustar à grade
                </label>
                <button
                  onClick={() => {
                    const item = lab.change((engine) =>
                      addCanvasItem(engine, {
                        kind: 'note',
                        text: 'Nova nota',
                        position: { x: 120, y: 80 },
                        width: 220,
                        height: 120,
                        color: 'lime',
                      })
                    );
                    if (item) setSelected([item.id]);
                    setMore(false);
                  }}
                >
                  <StickyNote size={16} /> Adicionar nota
                </button>
                <button
                  onClick={() => {
                    const item = lab.change((engine) =>
                      addCanvasItem(engine, {
                        kind: 'region',
                        text: 'Região',
                        position: { x: 80, y: 40 },
                        width: 600,
                        height: 320,
                        color: 'cyan',
                      })
                    );
                    if (item) setSelected([item.id]);
                    setMore(false);
                  }}
                >
                  <Square size={16} /> Adicionar região
                </button>
                <button
                  disabled={
                    selected.filter((id) => lab.engine.state.devices.some((device) => device.id === id))
                      .length < 2
                  }
                  onClick={() => {
                    const group = lab.change((engine) => groupDevices(engine, selected));
                    if (group) setSelected([group.id]);
                    setMore(false);
                  }}
                >
                  <Group size={16} /> Agrupar seleção
                </button>
                <button
                  disabled={
                    !lab.engine.state.canvasItems?.some(
                      (item) => item.kind === 'group' && selected.includes(item.id)
                    )
                  }
                  onClick={() => {
                    lab.change((engine) =>
                      engine.state.canvasItems
                        ?.filter((item) => item.kind === 'group' && selected.includes(item.id))
                        .forEach((item) => removeCanvasItem(engine, item.id, true))
                    );
                    setSelected([]);
                    setMore(false);
                  }}
                >
                  <Ungroup size={16} /> Desagrupar
                </button>
                <button
                  aria-pressed={drawing}
                  onClick={() => {
                    setDrawing(!drawing);
                    setMore(false);
                  }}
                >
                  Desenhar à mão livre
                </button>
                <button
                  disabled={!lab.engine.state.devices.length}
                  onClick={() => {
                    setComment(true);
                    setMore(false);
                  }}
                >
                  Adicionar comentário ancorado
                </button>
                <label className="checkbox-label">
                  <input type="checkbox" checked={detailed} onChange={(e) => setDetailed(e.target.checked)} />{' '}
                  Mostrar portas
                </label>
              </div>
            )}
          </div>
        </div>
      </div>
      {comment && <CommentDialog lab={lab} selected={selected[0]} onClose={() => setComment(false)} />}
      {capture && <CaptureDialog lab={lab} onClose={() => setCapture(false)} />}
      {lab.error && (
        <div className="workspace-alert" role="alert">
          <span>{lab.error}</span>
          <button className="icon-button" aria-label="Fechar erro" onClick={() => lab.setError('')}>
            <X size={16} />
          </button>
        </div>
      )}
      <div className="workspace-main">
        {showCatalog && (
          <aside className="equipment-panel">
            <div className="panel-heading">
              EQUIPAMENTOS <span className="count">{deviceProfiles.length}</span>
            </div>
            <label className="search equipment-search">
              <Search size={15} />
              <input
                placeholder="Buscar equipamento…"
                aria-label="Buscar equipamento"
                value={catalogQuery}
                onChange={(e) => setCatalogQuery(e.target.value)}
              />
            </label>
            <p className="panel-description">Arraste para o canvas ou clique para adicionar.</p>
            <div className="catalog-section-label">PERFIS DE REDE</div>
            {deviceProfiles
              .filter((c) =>
                (c.name + ' ' + c.category + ' ' + c.role).toLowerCase().includes(catalogQuery.toLowerCase())
              )
              .map((c, i, visible) => (
                <div key={c.id}>
                  {(i === 0 || visible[i - 1].category !== c.category) && (
                    <div className="catalog-section-label">{c.category}</div>
                  )}
                  <button
                    className="equipment-card"
                    title={c.description}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('application/shlab-profile', c.id);
                      e.dataTransfer.effectAllowed = 'copy';
                    }}
                    key={c.id}
                    onClick={() =>
                      lab.change((e) => {
                        const d = e.addProfile(c.id, {
                          x: 80 + (e.state.devices.length % 4) * 240,
                          y: 120 + Math.floor(e.state.devices.length / 4) * 160,
                        });
                        setSelected([d.id]);
                      })
                    }
                  >
                    <span>
                      <DeviceIcon profile={c.id} type={c.type} size={37} />
                    </span>
                    <div>
                      <strong>{c.name}</strong>
                      <small>
                        {c.id === 'rack'
                          ? 'Montagem física · 42 U'
                          : c.id === 'ups'
                            ? 'Bateria e potência'
                            : c.ports
                              ? c.ports + ' portas · ' + (c.uplinks ?? 'Ethernet')
                              : c.type === 'switch'
                                ? '8 RJ45 + 2 SFP'
                                : c.type === 'router'
                                  ? '4 RJ45 + 2 SFP'
                                  : (c.ports ?? (c.type === 'pc' ? 1 : 2)) + ' × Ethernet'}
                      </small>
                    </div>
                    <Plus size={15} />
                  </button>
                </div>
              ))}
            <div className="catalog-section-label">CONEXÕES</div>
            <button className="equipment-card cable-card" onClick={() => setConnect(true)}>
              <span>
                <Cable size={24} />
              </span>
              <div>
                <strong>Cabo de rede</strong>
                <small>Cobre ou fibra óptica</small>
              </div>
              <Plus size={15} />
            </button>
            <div className="catalog-lesson">
              <BookOpen size={19} />
              <h4>Um laboratório de verdade.</h4>
              <p>Cada comando altera a rede. Cada evento explica uma decisão.</p>
              <button onClick={() => setHelp(true)}>
                Guia rápido <ChevronRight size={14} />
              </button>
            </div>
            <div className="catalog-bottom">
              <span className="status-dot" /> Motor determinístico <span>seed {lab.engine.state.seed}</span>
            </div>
          </aside>
        )}
        <div className="canvas-and-timeline">
          <div className="canvas-area">
            <div className="canvas-floating-toolbar">
              <label className="search canvas-search">
                <Search size={14} />
                <input
                  aria-label="Localizar equipamento"
                  placeholder="Localizar equipamento…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <select
                aria-label="Destacar VLAN"
                value={highlight ?? ''}
                onChange={(e) => setHighlight(e.target.value ? Number(e.target.value) : undefined)}
              >
                <option value="">Todas as VLANs</option>
                {[...new Set(lab.engine.state.devices.flatMap((d) => d.vlans.map((v) => v.id)))]
                  .sort((a, b) => a - b)
                  .map((v) => (
                    <option value={v} key={v}>
                      VLAN {v}
                    </option>
                  ))}
              </select>
            </div>
            <TopologyCanvas
              lab={lab}
              selected={selected}
              onSelect={setSelected}
              onConnect={setConnect}
              onEdge={setLink}
              detailed={detailed}
              highlight={highlight}
              query={query}
              drawing={drawing}
              onDrawingDone={() => setDrawing(false)}
            />
            {lastProbe && (
              <div className={'probe-toast ' + (lastProbe.status === 'success' ? 'success' : '')}>
                <span>{lastProbe.status === 'success' ? <Check size={15} /> : <Network size={15} />}</span>
                <strong>{lastProbe.target}</strong>
                <small>
                  {lastProbe.status === 'pending'
                    ? 'Pacote em trânsito'
                    : lastProbe.status === 'success'
                      ? 'Resposta em ' + lastProbe.rtt?.toFixed(2) + ' ms'
                      : lastProbe.status}
                </small>
              </div>
            )}
          </div>
          <Timeline lab={lab} onSelect={(id) => setSelected([id])} />
        </div>
        {device && <Inspector key={device.id} lab={lab} device={device} onClose={() => setSelected([])} />}
      </div>
      <footer className="workspace-status">
        <span>
          <MousePointer2 size={12} /> Arraste para mover <span>·</span> Shift para selecionar <span>·</span>{' '}
          Ctrl+S para salvar
        </span>
        <span>
          <span className="status-dot" /> NetOS 1.0 <span>·</span> Simulação local <span>·</span>{' '}
          {lab.engine.state.devices.length}/2000 dispositivos
        </span>
      </footer>
      <input
        ref={importRef}
        type="file"
        accept=".json,.shlab.json,.netlab.json"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          try {
            if (file.size > 16 * 1024 * 1024) throw new Error('Arquivo excede 16 MB');
            lab.restore(JSON.parse(await file.text()));
            setSelected([]);
          } catch (e) {
            lab.setError((e as Error).message);
          }
          e.target.value = '';
        }}
      />
      {connect && (
        <ConnectDialog
          lab={lab}
          initial={connect === true ? undefined : connect}
          onClose={() => setConnect(null)}
        />
      )}
      {link && lab.engine.state.links.some((l) => l.id === link) && (
        <LinkDialog lab={lab} id={link} onClose={() => setLink(null)} />
      )}
      {ping && (
        <Modal title="Enviar pacote ICMP" onClose={() => setPing(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const result = lab.change(
                (sim) =>
                  sim.ping(
                    String(f.get('source')),
                    String(f.get('target')),
                    64,
                    String(f.get('vrf') ?? '') || undefined,
                    Number(f.get('bytes') ?? 84),
                    f.get('df') === 'on'
                  ),
                false
              );
              if (result) {
                setPing(false);
                if (mode === 'realtime') lab.setPlaying(true);
              }
            }}
          >
            <p className="muted">
              O motor resolve ARP, consulta rotas e acompanha a resposta. No modo simulação, use Executar ou
              Próximo evento.
            </p>
            <label>
              Equipamento de origem
              <select
                name="source"
                value={pingSource}
                onChange={(event) => setPingSource(event.target.value)}
              >
                {lab.engine.state.devices
                  .filter((d) => d.type !== 'switch' || d.interfaces.some((p) => p.logical?.kind === 'svi'))
                  .map((d) => (
                    <option value={d.id} key={d.id}>
                      {d.hostname} · {d.interfaces.find((i) => i.ip)?.ip ?? 'sem IP'}
                    </option>
                  ))}
              </select>
            </label>
            {!!lab.engine.state.devices.find((d) => d.id === pingSource)?.vrfs?.length && (
              <label>
                VRF do ping
                <select name="vrf" key={pingSource}>
                  <option value="">Padrão</option>
                  {lab.engine.state.devices
                    .find((d) => d.id === pingSource)
                    ?.vrfs?.map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                </select>
              </label>
            )}
            <label>
              Destino IPv4 ou hostname
              <input
                name="target"
                required
                autoFocus
                placeholder="192.168.20.10"
                defaultValue={
                  lab.engine.state.devices
                    .filter((d) => d.type !== 'switch')
                    .at(-1)
                    ?.interfaces.find((i) => i.ip)?.ip ?? ''
                }
              />
            </label>
            <details>
              <summary>Tamanho e fragmentação IPv4</summary>
              <label>
                Tamanho do pacote IPv4
                <input name="bytes" type="number" min="28" max="65535" defaultValue="84" />
              </label>
              <label className="checkbox-label">
                <input name="df" type="checkbox" />
                DF: impedir fragmentação
              </label>
              <p className="muted">
                Pacotes maiores que a MTU são fragmentados. DF solicita ICMP Fragmentation Needed.
              </p>
            </details>
            {lab.error && (
              <div className="alert error" role="alert">
                {lab.error}
              </div>
            )}
            <button className="button primary">
              <Send size={16} /> Enfileirar ping
            </button>
          </form>
        </Modal>
      )}
      {snapshots && <Snapshots lab={lab} projectId={project.id} onClose={() => setSnapshots(false)} />}
      {showChallenge && <LearningPanel project={project} lab={lab} onClose={() => setShowChallenge(false)} />}
      {showTutorial && (
        <TutorialPanel
          project={project}
          lab={lab}
          onClose={() => setShowTutorial(false)}
          onNavigate={(panel) => {
            if (panel === 'catalog') setShowCatalog(true);
            if (panel === 'connections') setConnect(true);
            if (panel === 'inspector') {
              const hosts = lab.engine.state.devices.filter((d) => d.type === 'pc');
              setSelected([hosts[hosts.length > 1 ? 1 : 0]?.id ?? '']);
            }
            if (panel === 'timeline')
              document.querySelector('.timeline')?.scrollIntoView({ block: 'nearest' });
          }}
        />
      )}
      {showTasks && project.lab_id && (
        <LabPanel project={project} lab={lab} onClose={() => setShowTasks(false)} />
      )}
      {showNetwork && (
        <NetworkInspector
          lab={lab}
          onClose={() => setShowNetwork(false)}
          onInspect={(id) => setSelected([id])}
        />
      )}
      {help && (
        <Modal title="Seu primeiro pacote, passo a passo" onClose={() => setHelp(false)} wide>
          <div className="help-intro">
            <BookOpen size={26} />
            <p>
              O shLab simula a rede a partir das configurações dos equipamentos. Você pode montar, quebrar e
              investigar cada conexão.
            </p>
          </div>
          <ol className="help-steps">
            <li>
              <strong>Monte uma LAN.</strong> Adicione dois computadores e um switch. Conecte Eth0 dos hosts
              em portas distintas do switch.
            </li>
            <li>
              <strong>Configure os IPs.</strong> Em Portas, use 192.168.10.10/24 e 192.168.10.20/24. Na mesma
              sub-rede, o gateway é opcional.
            </li>
            <li>
              <strong>Envie um ping.</strong> Escolha a origem e o destino; clique em Executar ou avance um
              evento de cada vez.
            </li>
            <li>
              <strong>Observe as decisões.</strong> Clique nos eventos ARP, consulte a tabela MAC e abra o
              inspetor de frames.
            </li>
            <li>
              <strong>Provoque uma falha.</strong> Desligue uma interface e envie outro ping. Corrija a
              configuração e teste novamente.
            </li>
          </ol>
          <div className="help-code">
            <TerminalExample />
          </div>
          <p className="muted">
            Atalhos: Ctrl+S salvar · Ctrl+Z desfazer · Ctrl+Shift+Z refazer · Ctrl+C/V copiar/colar · Ctrl+D
            duplicar · Delete excluir. Ao duplicar, IPs são removidos para evitar conflitos.
          </p>
          <NetworkConceptGuide />
          <div className="learning-card">
            <p>
              Ethernet, ARP, IPv4, ICMP, VLAN access/trunk, rotas estáticas, DHCPv4 com relay e reservas, DNS,
              STP/RSTP, OSPF, RIPv2, BGP e gateway VRRP IPv4. ACL/NAT e firewall com zonas abrangem TCP, UDP,
              ping e erros ICMP relacionados. Serviços echo/HTTP, SNMP de leitura e syslog UDP usam a rede
              simulada. BGP, Wi-Fi, VPN/SD-WAN, IPv6, LACP, VRF, QoS, MPLS, VXLAN/EVPN, AAA e automação
              possuem templates e labs. Internet real não é acessada.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}
function TerminalExample() {
  return (
    <>
      <span>EXEMPLO NETOS · CRIAR UMA VLAN</span>
      <pre>
        {
          'enable\nconfigure terminal\nvlan 10\nname USERS\nexit\ninterface Gi0/1\nswitchport mode access\nswitchport access vlan 10\nend\nshow vlan'
        }
      </pre>
    </>
  );
}
function Snapshots({
  lab,
  projectId,
  onClose,
}: {
  lab: LabController;
  projectId: string;
  onClose: () => void;
}) {
  const [versions, setVersions] = useState<{ id: string; label: string; created_at: string }[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const refresh = () =>
    api<typeof versions>('/projects/' + projectId + '/snapshots')
      .then(setVersions)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <Modal title="Snapshots do laboratório" onClose={onClose}>
      <p className="muted">Guarde um estado completo: configurações, tabelas, relógio e eventos pendentes.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          setBusy(true);
          try {
            await lab.save();
            await api('/projects/' + projectId + '/snapshots', {
              method: 'POST',
              body: { label: f.get('label') },
            });
            await refresh();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Nome do snapshot
          <input name="label" required maxLength={100} placeholder="Antes de configurar as VLANs" />
        </label>
        <button className="button primary" disabled={busy}>
          <FolderClock size={16} /> Criar snapshot
        </button>
      </form>
      {error && <div className="alert error">{error}</div>}
      <div className="snapshot-list">
        {versions.map((v) => (
          <div key={v.id}>
            <span>
              <FileJson size={18} />
              <strong>{v.label}</strong>
              <small>{new Date(v.created_at).toLocaleString('pt-BR')}</small>
            </span>
            <button
              className="button small"
              onClick={async () => {
                try {
                  const r = await api<{ topology: Snapshot }>(
                    '/projects/' + projectId + '/snapshots/' + v.id
                  );
                  lab.restore(r.topology);
                  onClose();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Restaurar
            </button>
          </div>
        ))}
      </div>
      {!versions.length && <p className="muted">Nenhum snapshot salvo ainda.</p>}
    </Modal>
  );
}
