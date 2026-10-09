import { DrawingLayer } from './DrawingLayer';
import { canvasPosition, radioCoverage } from '@shlab/engine';
import { useEffect, useCallback, useMemo, useState, useRef, memo } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  MiniMap,
  Controls,
  Handle,
  Position,
  ConnectionMode,
  BaseEdge,
  getBezierPath,
  applyNodeChanges,
  useReactFlow,
  useNodesInitialized,
  useStore,
  NodeResizer,
  type Node,
  type NodeProps,
  type EdgeProps,
  type Connection,
  type Edge,
} from '@xyflow/react';
import { Network, MousePointer2 } from 'lucide-react';
import {
  type Device,
  type CanvasItem,
  linkOperational,
  moveCanvasItem,
  removeCanvasItem,
  deviceParticipatesInVlan,
  deviceProfile,
} from '@shlab/engine';
import { DeviceIcon } from '../components/DeviceIcon';
import type { LabController } from './useLab';
import '@xyflow/react/dist/style.css';
type DeviceNode = Node<
  { device: Device; detailed: boolean; overview: boolean; highlight: boolean; renderKey: string },
  'device'
>;
type AnnotationNode = Node<{ item: CanvasItem; change: (value: Partial<CanvasItem>) => void }, 'annotation'>;
type CanvasNode = DeviceNode | AnnotationNode;
const annotationColors = { cyan: '#0c9ca5', lime: '#63a423', blue: '#217ddd', rose: '#c95b88' };
function AnnotationView({ data, selected }: NodeProps<AnnotationNode>) {
  const item = data.item;
  return (
    <>
      <NodeResizer
        isVisible={selected && !item.points && !item.anchor}
        minWidth={80}
        minHeight={40}
        color={annotationColors[item.color]}
        onResizeEnd={(_event, size) =>
          data.change({ position: { x: size.x, y: size.y }, width: size.width, height: size.height })
        }
      />
      <div
        className={'canvas-item canvas-' + item.kind}
        style={{
          borderColor: annotationColors[item.color],
          background: annotationColors[item.color] + (item.kind === 'note' ? '22' : '0a'),
        }}
      >
        {item.points && (
          <svg aria-label={item.text} viewBox={`0 0 ${item.width} ${item.height}`}>
            <polyline
              points={item.points.map((p) => p.x + ',' + p.y).join(' ')}
              fill="none"
              stroke={annotationColors[item.color]}
              strokeWidth="3"
              strokeLinecap="round"
            />
          </svg>
        )}
        {selected ? (
          <textarea
            className="nodrag nowheel"
            aria-label="Texto da anotação"
            value={item.text}
            maxLength={1000}
            onChange={(event) => data.change({ text: event.target.value })}
          />
        ) : (
          <span>{item.text}</span>
        )}
        {selected && (
          <div className="annotation-swatches nodrag">
            {Object.entries(annotationColors).map(([color, value]) => (
              <button
                key={color}
                type="button"
                title={color}
                aria-label={'Cor ' + color}
                aria-pressed={item.color === color}
                style={{ background: value }}
                onClick={() => data.change({ color: color as CanvasItem['color'] })}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
function DeviceView({ data, selected }: NodeProps<DeviceNode>) {
  const d = data.device;
  if (data.overview)
    return (
      <div
        className={
          'network-device overview-device ' + (selected ? 'selected ' : '') + (!d.power ? 'powered-off' : '')
        }
        aria-label={d.hostname}
      >
        <strong>{d.hostname}</strong>
        <Handle
          role="img"
          aria-label={d.hostname + ' conexões'}
          id="overview"
          type="source"
          position={Position.Bottom}
          isConnectable={false}
        />
      </div>
    );
  return (
    <div
      className={
        'network-device ' +
        (selected ? 'selected ' : '') +
        (!d.power ? 'powered-off ' : '') +
        (data.highlight ? 'highlight ' : '')
      }
    >
      {d.wireless?.role === 'ap' && selected && (
        <div
          className="radio-coverage"
          role="img"
          aria-label="Cobertura aproximada do AP"
          style={{ width: radioCoverage(d) * 8, height: radioCoverage(d) * 8 }}
        >
          <span>Alcance didático ≈ {radioCoverage(d).toFixed(0)} m</span>
        </div>
      )}
      <div className="node-main">
        <DeviceIcon profile={d.profile} type={d.type} />
        <div>
          <span className="node-type">
            {d.wireless?.role === 'ap'
              ? 'ACCESS POINT'
              : d.type === 'switch'
                ? d.ipRouting
                  ? 'SWITCH L3'
                  : 'SWITCH L2'
                : d.type === 'router'
                  ? 'ROTEADOR'
                  : d.type === 'server'
                    ? 'SERVIDOR'
                    : 'COMPUTADOR'}
          </span>
          <strong>{d.hostname}</strong>
          <small>
            {d.interfaces.find((i) => i.ip)?.ip ??
              deviceProfile(d)?.model ??
              (d.type === 'switch' ? 'NetOS · ' + d.interfaces.length + ' portas' : 'IPv4 não configurado')}
          </small>
        </div>
        <span className={'node-status ' + (d.power ? '' : 'off')} title={d.power ? 'Ligado' : 'Desligado'} />
      </div>
      {data.detailed && (
        <div className="node-port-strip">
          {d.interfaces
            .filter((p) => !p.logical && !p.aggregate && !p.tunnel && !p.vxlan)
            .map((p) => (
              <span
                key={p.id}
                className={!p.adminUp ? 'off' : ''}
                title={
                  p.name +
                  ' · ' +
                  p.mode +
                  (['sfp', 'qsfp'].includes(p.media) ? ' · ' + p.media.toUpperCase() : '')
                }
              >
                <i />
                {p.name.replace('Gi0/', '')}
              </span>
            ))}
        </div>
      )}
      {d.interfaces
        .filter((p) => !p.logical && !p.aggregate && !p.tunnel && !p.vxlan)
        .map((p, i) => (
          <Handle
            role="img"
            key={p.id}
            id={p.id}
            isConnectable={p.media !== 'wifi' && !p.capwapPeer}
            type="source"
            position={Position.Bottom}
            style={{
              left: ((i + 1) / (d.interfaces.length + 1)) * 100 + '%',
              background: p.adminUp ? '#1d8790' : '#9aa9b5',
            }}
            title={d.hostname + ' ' + p.name + ' · ' + p.media}
            aria-label={d.hostname + ' ' + p.name}
          />
        ))}
    </div>
  );
}
type CableEdge = Edge<{
  active?: string;
  blocked: boolean;
  discarding: boolean;
  control: boolean;
  reverse: boolean;
  cable: string;
}>;
function CableView(props: EdgeProps<CableEdge>) {
  const [path, labelX, labelY] = getBezierPath(props);
  const moving = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        className={props.data?.discarding ? 'stp-blocked' : undefined}
        style={{
          stroke: props.data?.blocked
            ? '#bb6865'
            : props.data?.discarding
              ? '#b48221'
              : props.selected
                ? '#1479c5'
                : '#8da7b5',
          strokeWidth: props.selected ? 3 : 2,
          strokeDasharray:
            props.data?.blocked || props.data?.discarding || props.data?.cable === 'wireless'
              ? '7 5'
              : undefined,
        }}
        interactionWidth={18}
      />
      <text x={labelX} y={labelY - 10} textAnchor="middle" className="cable-label">
        {props.label}
        {props.data?.discarding ? ' · STP discarding' : ''}
      </text>
      {props.data?.active && !props.data.blocked && (!props.data.discarding || props.data.control) && (
        <g key={props.data.active}>
          <rect
            x={moving ? -6 : labelX - 6}
            y={moving ? -4 : labelY - 4}
            width="12"
            height="8"
            rx="2"
            fill="#05a9b4"
            stroke="white"
            strokeWidth="2"
          />
          {moving && (
            <animateMotion
              dur=".6s"
              path={path}
              rotate="auto"
              fill="freeze"
              keyPoints={props.data.reverse ? '1;0' : '0;1'}
              keyTimes="0;1"
              calcMode="linear"
            />
          )}
        </g>
      )}
    </>
  );
}
const nodeTypes = {
    device: memo(
      DeviceView,
      (a, b) =>
        a.selected === b.selected &&
        a.data.renderKey === b.data.renderKey &&
        a.data.overview === b.data.overview &&
        a.data.detailed === b.data.detailed &&
        a.data.highlight === b.data.highlight
    ),
    annotation: AnnotationView,
  },
  edgeTypes = { cable: CableView };
interface Props {
  lab: LabController;
  selected: string[];
  onSelect: (ids: string[]) => void;
  onConnect: (c: Connection) => void;
  onEdge: (id: string) => void;
  detailed: boolean;
  highlight: number | undefined;
  query: string;
  drawing: boolean;
  onDrawingDone: () => void;
}
function Canvas({
  lab,
  selected,
  onSelect,
  onConnect,
  onEdge,
  detailed,
  highlight,
  query,
  drawing,
  onDrawingDone,
}: Props) {
  const { engine, tick } = lab,
    { screenToFlowPosition, fitView, setCenter, getViewport } = useReactFlow();
  const zoom = useStore((state) => state.transform[2]);
  const overview = engine.state.devices.length > 200 && zoom < 0.45;
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const nodesInitialized = useNodesInitialized();
  const fittedDeviceCount = useRef(engine.state.devices.length);
  useEffect(() => {
    const size = engine.state.devices.length;
    if (size === fittedDeviceCount.current || nodes.filter((n) => n.type === 'device').length !== size)
      return;
    if (size > fittedDeviceCount.current) {
      if (size <= 200) {
        if (!nodesInitialized || nodes.some((n) => !n.measured?.width || !n.measured?.height)) return;
        void fitView({ padding: 0.3, maxZoom: 1.5 });
      } else {
        const added = engine.state.devices.find((d) => selected.includes(d.id));
        if (added)
          void setCenter(added.position.x + 100, added.position.y + 40, {
            zoom: Math.max(0.5, getViewport().zoom),
          });
      }
    }
    fittedDeviceCount.current = size;
  }, [engine, nodes, nodesInitialized, selected, fitView, setCenter, getViewport]);
  const previousEdges = useRef(new Map<string, CableEdge>());
  useEffect(() => {
    const items = engine.state.canvasItems ?? [];
    const parents = new Map<string, CanvasItem>();
    for (const item of items) for (const member of item.members ?? []) parents.set(member, item);
    const annotations: AnnotationNode[] = items.map((item) => ({
      id: item.id,
      type: 'annotation',
      position: canvasPosition(engine.state, item),
      selected: selected.includes(item.id),
      style: {
        width: item.width,
        height: item.height,
        zIndex: ['note', 'comment'].includes(item.kind) ? 2 : -1,
      },
      data: {
        item,
        change: (value) =>
          lab.change((simulation) => {
            Object.assign(
              simulation.state.canvasItems!.find((entry) => entry.id === item.id)!,
              value
            );
          }),
      },
    }));
    const devices: DeviceNode[] = engine.state.devices.map((d) => {
      const parent = parents.get(d.id);
      return {
        id: d.id,
        type: 'device',
        position: parent
          ? { x: d.position.x - parent.position.x, y: d.position.y - parent.position.y }
          : d.position,
        ...(parent ? { parentId: parent.id, extent: 'parent' as const } : {}),
        selected: selected.includes(d.id),
        data: {
          device: d,
          overview,
          renderKey: JSON.stringify([
            d.hostname,
            d.type,
            d.profile,
            d.power,
            d.ipRouting,
            d.wireless?.role,
            d.wireless?.enabled,
            d.wireless?.txPower,
            d.wireless?.band,
            d.wireless?.noise,
            d.wireless?.attenuation,
            d.interfaces.map((p) => [p.id, p.name, p.ip, p.mode, p.media, p.adminUp, p.capwapPeer]),
          ]),
          detailed,
          highlight: highlight !== undefined && deviceParticipatesInVlan(engine.state, d.id, highlight),
        },
        className: query && !d.hostname.toLowerCase().includes(query.toLowerCase()) ? 'dim-node' : '',
      };
    });
    setNodes((previous) => {
      const byId = new Map(previous.map((node) => [node.id, node]));
      const next = [...annotations, ...devices].map((node) => {
        const old = byId.get(node.id);
        if (
          old?.type === 'device' &&
          node.type === 'device' &&
          old.selected === node.selected &&
          old.parentId === node.parentId &&
          old.className === node.className &&
          old.position.x === node.position.x &&
          old.position.y === node.position.y &&
          old.data.renderKey === node.data.renderKey &&
          old.data.overview === node.data.overview &&
          old.data.detailed === node.data.detailed &&
          old.data.highlight === node.data.highlight
        )
          return old;
        return node;
      });
      return next.length === previous.length && next.every((node, i) => node === previous[i])
        ? previous
        : next;
    });
  }, [engine, tick, selected, detailed, highlight, query, lab.change, overview]);
  const edges = useMemo<CableEdge[]>(() => {
    const sent = new Map<string, (typeof engine.state.events)[number]>();
    for (const event of engine.state.events)
      if (event.type === 'FRAME_SENT' && event.link) sent.set(event.link, event);
    const next = engine.state.links.map((l) => {
      const a = engine.device(l.a.device),
        b = engine.device(l.b.device);
      const recent = sent.get(l.id);
      const edge: CableEdge = {
        id: l.id,
        source: l.a.device,
        sourceHandle: overview ? 'overview' : l.a.port,
        target: l.b.device,
        targetHandle: overview ? 'overview' : l.b.port,
        type: 'cable',
        label: overview
          ? ''
          : a.interfaces.find((p) => p.id === l.a.port)?.name +
            ' ↔ ' +
            b.interfaces.find((p) => p.id === l.b.port)?.name,
        data: {
          cable: l.cable,
          blocked: !linkOperational(engine.state, l),
          active: overview ? undefined : recent?.id,
          control: !!recent?.frame?.bpdu,
          reverse: recent?.device === l.b.device,
          discarding:
            linkOperational(engine.state, l) &&
            [
              a.interfaces.find((port) => port.id === l.a.port),
              b.interfaces.find((port) => port.id === l.b.port),
            ].some((port) => port?.spanningTree && port.spanningTree.state !== 'forwarding'),
        },
      };
      const old = previousEdges.current.get(l.id);
      return old && JSON.stringify(old) === JSON.stringify(edge) ? old : edge;
    });
    previousEdges.current = new Map(next.map((edge) => [edge.id, edge]));
    return next;
  }, [engine, tick, overview]);
  const onNodesChange = useCallback(
    (changes: Parameters<typeof applyNodeChanges<CanvasNode>>[0]) =>
      setNodes((ns) => applyNodeChanges(changes, ns)),
    []
  );
  const onSelectionChange = useCallback(
    ({ nodes: selection }: { nodes: CanvasNode[] }) => onSelect(selection.map((node) => node.id)),
    [onSelect]
  );
  return (
    <div
      className={'canvas-container theme-' + engine.state.background}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(e) => {
        e.preventDefault();
        const profile = e.dataTransfer.getData('application/shlab-profile');
        if (profile) {
          const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
          lab.change((sim) => sim.addProfile(profile, position));
          return;
        }
        const type = e.dataTransfer.getData('application/shlab');
        if (!['pc', 'switch', 'router', 'server'].includes(type)) return;
        const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        lab.change((sim) => sim.addDevice(type as Device['type'], position));
      }}
    >
      <ReactFlow<CanvasNode, CableEdge>
        onlyRenderVisibleElements={engine.state.devices.length > 200}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={(_e, _node, moved) =>
          lab.change((sim) => {
            const moving = new Set(moved.map((node) => node.id));
            for (const node of moved) {
              if (node.parentId && moving.has(node.parentId)) continue;
              const parent = sim.state.canvasItems?.find((item) => item.id === node.parentId);
              moveCanvasItem(
                sim,
                node.id,
                parent
                  ? { x: node.position.x + parent.position.x, y: node.position.y + parent.position.y }
                  : node.position
              );
            }
          })
        }
        onMoveEnd={(_event, viewport) => {
          const previous = engine.state.viewport;
          if (
            !previous ||
            previous.x !== viewport.x ||
            previous.y !== viewport.y ||
            previous.zoom !== viewport.zoom
          )
            lab.change(
              (simulation) => {
                simulation.state.viewport = viewport;
              },
              false,
              false
            );
        }}
        onSelectionChange={onSelectionChange}
        onConnect={onConnect}
        onEdgeClick={(_e, edge) => onEdge(edge.id)}
        connectionMode={ConnectionMode.Loose}
        onNodesDelete={(deleted) =>
          lab.change((sim) => {
            for (const node of deleted) removeCanvasItem(sim, node.id);
          })
        }
        deleteKeyCode={['Backspace', 'Delete']}
        selectionKeyCode="Shift"
        multiSelectionKeyCode="Shift"
        snapToGrid={engine.state.snapToGrid ?? true}
        snapGrid={[20, 20]}
        minZoom={0.15}
        maxZoom={2.5}
        fitView={!engine.state.viewport || window.innerWidth < 700}
        defaultViewport={window.innerWidth < 700 ? undefined : engine.state.viewport}
        fitViewOptions={{ padding: 0.3 }}
        colorMode={engine.state.background === 'dark' ? 'dark' : 'light'}
        proOptions={{ hideAttribution: false }}
      >
        {engine.state.pattern !== 'none' && (
          <Background
            variant={engine.state.pattern === 'dots' ? BackgroundVariant.Dots : BackgroundVariant.Lines}
            gap={engine.state.pattern === 'fine-grid' ? 10 : 20}
            size={1}
            color={engine.state.background === 'dark' ? '#304556' : '#d1dce3'}
          />
        )}
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={(n) =>
            n.type === 'annotation'
              ? annotationColors[(n.data.item as CanvasItem).color]
              : (n.data.device as Device).type === 'router'
                ? '#5986aa'
                : (n.data.device as Device).type === 'switch'
                  ? '#4caca7'
                  : '#bbcbd7'
          }
          maskColor={engine.state.background === 'dark' ? '#11283ba6' : '#f2f6f9b0'}
          pannable
          zoomable
        />
      </ReactFlow>
      {drawing && <DrawingLayer lab={lab} onDone={onDrawingDone} />}
      {!engine.state.devices.length && !engine.state.canvasItems?.length && (
        <div className="canvas-empty">
          <span>
            <Network size={36} />
          </span>
          <h2>Toda rede começa com uma conexão.</h2>
          <p>
            Arraste seu primeiro equipamento para o canvas
            <br />
            ou clique no catálogo à esquerda.
          </p>
          <div>
            <MousePointer2 size={14} /> Arraste para mover · Scroll para zoom · Shift para selecionar
          </div>
        </div>
      )}
      <div className="canvas-coordinate">
        <span className="live-dot" /> {engine.state.devices.length} dispositivos <span>·</span>{' '}
        {engine.state.links.length} conexões <span>·</span> {engine.state.clock.toFixed(2)} ms
      </div>
    </div>
  );
}
export function TopologyCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
