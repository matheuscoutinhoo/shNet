import { devicePresentationProfile } from './deviceCapabilities';
import { findDevices } from './deviceFinder';
import { DrawingLayer } from './DrawingLayer';
import {
  collectCanvasActivities,
  emptyCanvasActivities,
  newCanvasEvents,
  pruneCanvasActivities,
  type CanvasActivities,
  type CanvasActivity,
} from './canvasActivity';
import { canvasPosition, radioCoverage, wirelessMetrics } from '@shlab/engine';
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
  useUpdateNodeInternals,
  useStore,
  NodeResizer,
  type Node,
  type NodeProps,
  type EdgeProps,
  type Connection,
  type Edge,
} from '@xyflow/react';
import { Network, MousePointer2, Wifi } from 'lucide-react';
import {
  type Device,
  type CanvasItem,
  linkOperational,
  moveCanvasItem,
  removeCanvasItem,
  deviceParticipatesInVlan,
} from '@shlab/engine';
import { DeviceIcon } from '../components/DeviceIcon';
import { DeviceActions, type DeviceAction } from './DeviceActions';
import { availablePorts } from './deviceCatalog';
import type { LabController } from './useLab';
import { topologyView, type TopologyView } from './topologyView';
import '@xyflow/react/dist/style.css';
type DeviceNode = Node<
  {
    device: Device;
    detailed: boolean;
    overview: boolean;
    highlight: boolean;
    renderKey: string;
    activity?: CanvasActivity;
    moving: boolean;
  },
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
  const updateNodeInternals = useUpdateNodeInternals();
  const interfaceIds = d.interfaces.map((p) => p.id).join(',');
  useEffect(() => {
    updateNodeInternals(d.id);
  }, [d.id, data.overview, data.detailed, interfaceIds, updateNodeInternals]);
  const presentation = devicePresentationProfile(d);
  const passive = ['rack', 'patch-panel'].includes(d.infrastructure?.kind ?? '');
  const activityClass = data.activity ? ' activity-' + data.activity.tone : '';
  const activityLabel = data.activity
    ? data.activity.reason
    : passive
      ? 'Infraestrutura passiva'
      : d.power
        ? 'Ligado'
        : 'Desligado';
  const activityAttributes = {
    'data-activity': data.activity?.kind ?? 'none',
    'data-event-id': data.activity?.eventId,
    'data-motion': data.moving && !passive ? 'active' : 'static',
  };
  if (data.overview)
    return (
      <div
        className={
          'network-device overview-device ' +
          (selected ? 'selected ' : '') +
          (!d.power ? 'powered-off' : '') +
          activityClass
        }
        aria-label={d.hostname}
        title={activityLabel}
        {...activityAttributes}
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
        (data.highlight ? 'highlight ' : '') +
        activityClass
      }
      {...activityAttributes}
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
        <DeviceIcon profile={presentation?.id} type={d.type} />
        <div>
          <span className="node-type">
            {presentation?.name.toLocaleUpperCase('pt-BR') ??
              (d.wireless?.role === 'ap'
                ? 'ACCESS POINT'
                : d.type === 'switch'
                  ? d.ipRouting
                    ? 'SWITCH L3'
                    : 'SWITCH L2'
                  : d.type === 'router'
                    ? 'ROTEADOR'
                    : d.type === 'server'
                      ? 'SERVIDOR'
                      : 'COMPUTADOR')}
          </span>
          <strong>{d.hostname}</strong>
          <small className={d.interfaces.some((p) => p.ip) ? 'node-address' : undefined}>
            {d.interfaces.find((i) => i.ip)?.ip ??
              presentation?.model ??
              (d.type === 'switch' ? 'NetOS · ' + d.interfaces.length + ' portas' : 'IPv4 não configurado')}
          </small>
        </div>
        {!passive && (
          <span
            className={'node-status ' + (d.power ? '' : 'off')}
            title={d.power ? 'Ligado' : 'Desligado'}
          />
        )}
      </div>
      {data.activity && (
        <span
          key={data.activity.eventId}
          className={'node-activity-indicator tone-' + data.activity.tone}
          title={activityLabel}
        >
          <span aria-hidden="true">
            {data.activity.kind === 'transmit'
              ? '↗'
              : data.activity.kind === 'receive'
                ? '↙'
                : data.activity.tone === 'drop'
                  ? '×'
                  : data.activity.tone === 'success'
                    ? '✓'
                    : '·'}
          </span>
          <span className="sr-only">{activityLabel}</span>
        </span>
      )}
      {data.detailed && d.infrastructure?.kind !== 'rack' && (
        <div className="node-port-strip">
          {d.interfaces
            .filter((p) => !p.logical && !p.aggregate && !p.tunnel && !p.vxlan)
            .map((p) => (
              <span
                key={p.id}
                className={
                  'port-' +
                  p.media +
                  (!p.adminUp ? ' off' : '') +
                  (data.activity?.port === p.id ? ' port-active tone-' + data.activity.tone : '')
                }
                title={
                  p.name + ' · ' + (passive ? 'Passagem passiva' : p.mode) + ' · ' + p.media.toUpperCase()
                }
              >
                {['wifi', 'mesh'].includes(p.media) ? <Wifi aria-hidden="true" /> : <i />}
                {p.name.replace('Gi0/', '')}
              </span>
            ))}
        </div>
      )}
      {d.interfaces
        .filter(
          (p) => d.infrastructure?.kind !== 'rack' && !p.logical && !p.aggregate && !p.tunnel && !p.vxlan
        )
        .map((p, i, ports) => (
          <Handle
            role="img"
            key={p.id}
            id={p.id}
            isConnectable={
              !['wifi', 'mesh'].includes(p.media) &&
              !p.capwapPeer &&
              !p.meshPeer &&
              d.infrastructure?.kind !== 'rack'
            }
            type="source"
            position={Position.Bottom}
            style={{
              left: ((i + 1) / (ports.length + 1)) * 100 + '%',
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
  activity?: CanvasActivity;
  moving: boolean;
  blocked: boolean;
  radioControlOperational: boolean;
  discarding: boolean;
  cable: string;
}>;
function CableView(props: EdgeProps<CableEdge>) {
  const [path, labelX, labelY] = getBezierPath(props);
  const activity = props.data?.activity;
  const packet = activity?.packet;
  const transmitting =
    !!packet &&
    (!props.data?.blocked || (packet.radioControl && props.data?.radioControlOperational)) &&
    (!props.data?.discarding || packet.control);
  const moving = !!props.data?.moving;
  const motionPath = packet?.reverse
    ? getBezierPath({
        ...props,
        sourceX: props.targetX,
        sourceY: props.targetY,
        sourcePosition: props.targetPosition,
        targetX: props.sourceX,
        targetY: props.sourceY,
        targetPosition: props.sourcePosition,
      })[0]
    : path;
  return (
    <g className="cable-visual" data-event-id={activity?.eventId} data-tone={activity?.tone}>
      <BaseEdge
        id={props.id}
        path={path}
        className={
          'cable-line ' +
          (props.data?.discarding ? 'stp-blocked ' : '') +
          (props.data?.blocked ? 'link-down ' : '') +
          (props.selected ? 'link-selected' : '')
        }
        style={{
          strokeDasharray:
            props.data?.blocked ||
            props.data?.discarding ||
            ['wireless', 'mesh'].includes(props.data?.cable ?? '')
              ? '7 5'
              : undefined,
        }}
        interactionWidth={18}
      />
      {activity && (
        <path
          className="cable-activity"
          d={path}
          fill="none"
          data-tone={activity.tone}
          data-event-id={activity.eventId}
          data-motion={moving ? 'active' : 'static'}
          aria-hidden="true"
        />
      )}
      <text x={labelX} y={labelY - 10} textAnchor="middle" className="cable-label">
        {props.label}
        {props.data?.discarding ? ' · STP discarding' : ''}
      </text>
      {transmitting && packet && (
        <g
          key={packet.eventId + (moving ? '-moving' : '-static')}
          className={'cable-packet tone-' + packet.tone}
          data-tone={packet.tone}
          data-event-id={packet.eventId}
          data-direction={packet.reverse ? 'reverse' : 'forward'}
          data-motion={moving ? 'active' : 'static'}
          transform={moving ? undefined : 'translate(' + labelX + ' ' + labelY + ')'}
          aria-hidden="true"
        >
          <circle className="packet-halo" r="11" />
          <rect className="packet-core" x="-7" y="-4" width="14" height="8" rx="2" />
          <path className="packet-direction" d="M -1 -2.5 L 3 0 L -1 2.5" />
          {moving && (
            <animateMotion
              dur=".72s"
              path={motionPath}
              rotate="auto"
              fill="freeze"
              keyPoints="0;1"
              keyTimes="0;1"
              calcMode="linear"
            />
          )}
        </g>
      )}
      {activity?.tone === 'drop' && (
        <g
          className="cable-drop-marker"
          transform={'translate(' + labelX + ' ' + labelY + ')'}
          aria-hidden="true"
        >
          <circle r="7" />
          <path d="M -2 -2 L 2 2 M 2 -2 L -2 2" />
        </g>
      )}
    </g>
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
        a.data.highlight === b.data.highlight &&
        a.data.activity === b.data.activity &&
        a.data.moving === b.data.moving
    ),
    annotation: AnnotationView,
  },
  edgeTypes = { cable: CableView };
interface Props {
  view: TopologyView;
  lab: LabController;
  selected: string[];
  onSelect: (ids: string[]) => void;
  onConnect: (c: Connection) => void;
  onEdge: (id: string) => void;
  onDeviceAction: (action: DeviceAction, id: string) => void;
  detailed: boolean;
  highlight: number | undefined;
  query: string;
  focusRequest?: { id: string; sequence: number };
  drawing: boolean;
  onDrawingDone: () => void;
}
function useCanvasMotion() {
  const [state, setState] = useState(() => ({
    visible: document.visibilityState !== 'hidden',
    reduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  }));
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setState({ visible: document.visibilityState !== 'hidden', reduced: media.matches });
    document.addEventListener('visibilitychange', update);
    media.addEventListener('change', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      media.removeEventListener('change', update);
    };
  }, []);
  return state;
}
function useCanvasActivities(lab: LabController, visible: boolean) {
  const { engine, tick, playing } = lab;
  const [activities, setActivities] = useState<CanvasActivities>(emptyCanvasActivities);
  const cursor = useRef({
    state: engine.state,
    id: engine.state.events.at(-1)?.id,
    sequence: engine.state.sequence,
    playing,
  });
  useEffect(() => {
    const previous = cursor.current;
    const events = engine.state.events;
    cursor.current = { state: engine.state, id: events.at(-1)?.id, sequence: engine.state.sequence, playing };
    // Loading, restoring or undoing a snapshot must not replay historical packets.
    if (!visible || engine.state !== previous.state || engine.state.sequence < previous.sequence) {
      setActivities(emptyCanvasActivities());
      return;
    }
    const fresh = newCanvasEvents(events, previous.id);
    if (fresh.length)
      setActivities((old) => collectCanvasActivities(old, fresh, engine.state.links, Date.now(), !playing));
    else if (playing && !previous.playing)
      setActivities((old) => {
        // A manual pulse becomes ordinary playback activity when Run is pressed.
        // Pausing immediately afterward must stop it just like a Worker-generated frame.
        const clearManual = (map: Map<string, CanvasActivity>) =>
          new Map(
            [...map].map(([id, activity]) => [
              id,
              activity.manualStep ? { ...activity, manualStep: false } : activity,
            ])
          );
        if (![...old.devices.values(), ...old.links.values()].some((activity) => activity.manualStep))
          return old;
        return { devices: clearManual(old.devices), links: clearManual(old.links) };
      });
  }, [engine, tick, playing, visible]);
  useEffect(() => {
    const all = [...activities.devices.values(), ...activities.links.values()];
    if (!all.length) return;
    const timer = setTimeout(
      () => setActivities((old) => pruneCanvasActivities(old, Date.now())),
      Math.max(
        1,
        Math.min(
          ...all.flatMap((activity) =>
            activity.packet ? [activity.expiresAt, activity.packet.expiresAt] : [activity.expiresAt]
          )
        ) - Date.now()
      )
    );
    return () => clearTimeout(timer);
  }, [activities]);
  return activities;
}
function Canvas({
  view,
  lab,
  selected,
  onSelect,
  onConnect,
  onEdge,
  onDeviceAction,
  detailed,
  highlight,
  query,
  focusRequest,
  drawing,
  onDrawingDone,
}: Props) {
  const { engine, tick } = lab,
    { screenToFlowPosition, fitView, setCenter, getViewport, getNode, setViewport } = useReactFlow();
  const motion = useCanvasMotion();
  const projection = useMemo(() => topologyView(engine.state, view), [engine, tick, view]);
  const activities = useCanvasActivities(lab, motion.visible);
  const canMove = motion.visible && !motion.reduced;
  const zoom = useStore((state) => state.transform[2]);
  const overview = engine.state.devices.length > 20 && zoom < 0.55;
  // Nodes update after the viewport changes. Draw each cable only once both
  // endpoints have measured handles for that rendering mode. This also keeps
  // offscreen nodes unmeasured without hiding cables whose endpoints are ready.
  const measuredEdgeIds = useStore((state) =>
    projection.links
      .filter((link) =>
        [link.a, link.b].every((end) => {
          const node = state.nodeLookup.get(end.device);
          return (
            node?.data.overview === overview &&
            node.internals.handleBounds?.source?.some(
              (handle) => handle.id === (overview ? 'overview' : end.port)
            )
          );
        })
      )
      .map((link) => link.id)
      .join('\n')
  );
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const container = useRef<HTMLDivElement>(null);
  const [actions, setActions] = useState<{ id: string; x: number; y: number; trigger: HTMLElement } | null>(
    null
  );
  const closeActions = useCallback(
    (restoreFocus = false) => {
      if (restoreFocus && actions?.trigger.isConnected) actions.trigger.focus();
      setActions(null);
    },
    [actions]
  );
  const actionDevice = engine.state.devices.find((device) => device.id === actions?.id);
  useEffect(() => {
    if (actions && !selected.includes(actions.id)) setActions(null);
  }, [actions, selected]);
  const nodesInitialized = useNodesInitialized();
  const previousView = useRef(view);
  useEffect(() => {
    if (previousView.current === view) return;
    previousView.current = view;
    const timer = setTimeout(() => {
      if (view === 'physical' && engine.state.viewport) void setViewport(engine.state.viewport);
      else void fitView({ padding: 0.2, maxZoom: 1.2 });
    }, 100);
    return () => clearTimeout(timer);
  }, [view, engine, fitView, setViewport]);
  useEffect(() => {
    const compact = window.matchMedia('(max-width: 699px)');
    let timer: ReturnType<typeof setTimeout>;
    const refit = () => {
      clearTimeout(timer);
      if (compact.matches && nodesInitialized && engine.state.devices.length)
        timer = setTimeout(() => void fitView({ padding: 0.2, maxZoom: 1.5 }), 150);
    };
    compact.addEventListener('change', refit);
    return () => {
      compact.removeEventListener('change', refit);
      clearTimeout(timer);
    };
  }, [nodesInitialized, engine, fitView]);
  const matches = findDevices(engine.state.devices, query);
  const matchIds = matches.map((d) => d.id).join(',');
  const lastSearch = useRef('');
  const focusDevice = useCallback(
    (id: string) => {
      const d = engine.state.devices.find((d) => d.id === id);
      if (!d) return;
      const node = getNode(id);
      onSelect([id]);
      void setCenter(
        (projection.positions.get(id) ?? d.position).x + (node?.measured?.width ?? 296) / 2,
        (projection.positions.get(id) ?? d.position).y + (node?.measured?.height ?? 154) / 2,
        { zoom: 1.2, duration: motion.reduced ? 0 : 300 }
      );
    },
    [engine, getNode, onSelect, setCenter, motion.reduced, projection]
  );
  useEffect(() => {
    if (!query.trim()) {
      lastSearch.current = '';
      return;
    }
    const key = query.trim().toLowerCase() + ':' + matchIds;
    if (key === lastSearch.current) return;
    const found = findDevices(engine.state.devices, query);
    const exact = found.find((d) => d.hostname.toLowerCase() === query.trim().toLowerCase());
    const target = exact ?? (found.length === 1 ? found[0] : undefined);
    if (!target) {
      lastSearch.current = '';
      return;
    }
    const timer = setTimeout(() => {
      lastSearch.current = key;
      focusDevice(target.id);
    }, 250);
    return () => clearTimeout(timer);
  }, [engine, query, matchIds, focusDevice]);
  const handledFocus = useRef(0);
  useEffect(() => {
    if (focusRequest && handledFocus.current !== focusRequest.sequence) {
      handledFocus.current = focusRequest.sequence;
      focusDevice(focusRequest.id);
    }
  }, [focusRequest, focusDevice]);
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
  const activityView = useRef({ activities, canMove, playing: lab.playing });
  activityView.current = { activities, canMove, playing: lab.playing };
  useEffect(() => {
    const activityState = activityView.current;
    const searchIds = new Set(findDevices(engine.state.devices, query).map((d) => d.id));
    const items = view === 'physical' ? (engine.state.canvasItems ?? []) : [];
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
    const devices: DeviceNode[] = projection.devices.map((d) => {
      const parent = parents.get(d.id);
      const activity = activityState.activities.devices.get(d.id);
      const handles = overview
        ? ['overview']
        : d.interfaces
            .filter(
              (p) => d.infrastructure?.kind !== 'rack' && !p.logical && !p.aggregate && !p.tunnel && !p.vxlan
            )
            .map((p) => p.id);
      const width = overview ? 220 : 204,
        height = overview ? 50 : detailed ? 154 : 80;
      return {
        id: d.id,
        type: 'device',
        // Supply dimensions before mounting so viewport culling does not need
        // to render and measure every node in a large imported topology.
        initialWidth: overview ? 220 : 204,
        initialHeight: overview ? 50 : detailed ? 154 : 80,
        handles: handles.map((id, i) => ({
          id,
          type: 'source' as const,
          position: Position.Bottom,
          x: (width * (i + 1)) / (handles.length + 1) - 3.5,
          y: height - 3.5,
          width: 7,
          height: 7,
        })),
        position: parent
          ? { x: d.position.x - parent.position.x, y: d.position.y - parent.position.y }
          : (projection.positions.get(d.id) ?? d.position),
        draggable: view === 'physical',
        ...(parent ? { parentId: parent.id, extent: 'parent' as const } : {}),
        selected: selected.includes(d.id),
        data: {
          device: d,
          overview,
          activity,
          moving:
            !overview &&
            !!activity &&
            activityState.canMove &&
            (activityState.playing || activity.manualStep),
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
        className: searchIds.size && !searchIds.has(d.id) ? 'dim-node' : '',
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
          old.data.highlight === node.data.highlight &&
          old.data.activity === node.data.activity &&
          old.data.moving === node.data.moving
        )
          return old;
        if (old?.type === 'device' && node.type === 'device') {
          // Retain ReactFlow measurements across data/activity changes. Dropping
          // them makes the store repeatedly alternate between initialized and
          // uninitialized while selection and playback are being synchronized.
          return {
            ...node,
            measured: old.measured,
            width: old.width,
            height: old.height,
            handles: old.measured?.width && old.measured?.height ? undefined : node.handles,
          };
        }
        return node;
      });
      return next.length === previous.length && next.every((node, i) => node === previous[i])
        ? previous
        : next;
    });
  }, [engine, tick, selected, detailed, highlight, query, lab.change, overview, view, projection]);
  useEffect(() => {
    // Transient highlights must not rebuild geometry and serialize every device again.
    setNodes((previous) => {
      let changed = false;
      const next = previous.map((node) => {
        if (node.type !== 'device') return node;
        const activity = activities.devices.get(node.id);
        const moving = !overview && !!activity && canMove && (lab.playing || activity.manualStep);
        if (node.data.activity === activity && node.data.moving === moving) return node;
        changed = true;
        return { ...node, data: { ...node.data, activity, moving } };
      });
      return changed ? next : previous;
    });
  }, [activities.devices, canMove, lab.playing, overview]);
  const baseEdges = useMemo<CableEdge[]>(() => {
    const devicesById = new Map(engine.state.devices.map((device) => [device.id, device]));
    const next = projection.links.map((l) => {
      const a = devicesById.get(l.a.device)!,
        b = devicesById.get(l.b.device)!;
      const operational = linkOperational(engine.state, l);
      const edge: CableEdge = {
        id: l.id,
        source: l.a.device,
        sourceHandle: overview ? 'overview' : l.a.port,
        target: l.b.device,
        targetHandle: overview ? 'overview' : l.b.port,
        type: 'cable',
        label:
          projection.labels.get(l.id) ||
          (overview
            ? ''
            : a.interfaces.find((p) => p.id === l.a.port)?.name +
              ' ↔ ' +
              b.interfaces.find((p) => p.id === l.b.port)?.name),
        data: {
          cable: l.cable,
          blocked: !operational,
          radioControlOperational:
            ['wireless', 'mesh'].includes(l.cable) && wirelessMetrics(engine.state, l).operational,
          moving: false,
          discarding:
            operational &&
            [
              a.interfaces.find((port) => port.id === l.a.port),
              b.interfaces.find((port) => port.id === l.b.port),
            ].some((port) => port?.spanningTree && port.spanningTree.state !== 'forwarding'),
        },
      };
      const old = previousEdges.current.get(l.id);
      return old &&
        old.source === edge.source &&
        old.target === edge.target &&
        old.sourceHandle === edge.sourceHandle &&
        old.targetHandle === edge.targetHandle &&
        old.label === edge.label &&
        old.data?.blocked === edge.data?.blocked &&
        old.data?.radioControlOperational === edge.data?.radioControlOperational &&
        old.data?.discarding === edge.data?.discarding &&
        old.data?.cable === edge.data?.cable
        ? old
        : edge;
    });
    previousEdges.current = new Map(next.map((edge) => [edge.id, edge]));
    return next;
  }, [engine, tick, overview, projection]);
  const decoratedEdges = useRef(new Map<string, CableEdge>());
  const edges = useMemo<CableEdge[]>(() => {
    if (overview) return baseEdges;
    const next = baseEdges.map((edge) => {
      const activity = activities.links.get(edge.id);
      if (!activity) return edge;
      const moving = canMove && (lab.playing || activity.manualStep);
      const old = decoratedEdges.current.get(edge.id);
      if (
        old?.data?.activity === activity &&
        old.data.moving === moving &&
        old.data.blocked === edge.data?.blocked &&
        old.data.radioControlOperational === edge.data?.radioControlOperational &&
        old.data.discarding === edge.data?.discarding &&
        old.data.cable === edge.data?.cable &&
        old.source === edge.source &&
        old.target === edge.target &&
        old.sourceHandle === edge.sourceHandle &&
        old.targetHandle === edge.targetHandle &&
        old.label === edge.label
      )
        return old;
      return { ...edge, data: { ...edge.data!, activity, moving } };
    });
    decoratedEdges.current = new Map(next.map((edge) => [edge.id, edge]));
    return next;
  }, [baseEdges, overview, activities.links, canMove, lab.playing]);
  const onNodesChange = useCallback(
    (changes: Parameters<typeof applyNodeChanges<CanvasNode>>[0]) =>
      setNodes((ns) => applyNodeChanges(changes, ns)),
    []
  );
  const measuredEdges = useMemo(() => {
    const ids = new Set(measuredEdgeIds.split('\n'));
    return edges.filter((edge) => ids.has(edge.id));
  }, [edges, measuredEdgeIds]);
  const onSelectionChange = useCallback(
    ({ nodes: selection }: { nodes: CanvasNode[] }) => onSelect(selection.map((node) => node.id)),
    [onSelect]
  );
  return (
    <div
      ref={container}
      className={'canvas-container theme-' + engine.state.background}
      data-motion={canMove ? 'enabled' : 'static'}
      onKeyDownCapture={(event) => {
        if (
          !['Enter', ' '].includes(event.key) ||
          event.shiftKey ||
          event.ctrlKey ||
          event.metaKey ||
          (event.target as Element).closest('input,textarea,select,button,a')
        )
          return;
        const node = (event.target as Element).closest<HTMLElement>('.react-flow__node-device');
        if (!node?.dataset.id) return;
        event.preventDefault();
        event.stopPropagation();
        const bounds = node.getBoundingClientRect();
        onSelect([node.dataset.id]);
        setActions({ id: node.dataset.id, x: bounds.right, y: bounds.top, trigger: node });
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (view === 'logical') return;
        const profile = e.dataTransfer.getData('application/shlab-profile');
        if (profile) {
          const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
          lab.change((sim) => sim.addFactoryProfile(profile, position));
          return;
        }
        const type = e.dataTransfer.getData('application/shlab');
        if (!['pc', 'switch', 'router', 'server'].includes(type)) return;
        const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        lab.change((sim) => sim.addFactoryDevice(type as Device['type'], position));
      }}
    >
      <ReactFlow<CanvasNode, CableEdge>
        onlyRenderVisibleElements={engine.state.devices.length > 200}
        nodes={nodes}
        edges={measuredEdges}
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
          if (view === 'logical') return;
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
        onNodeClick={(event, node) => {
          if (
            node.type !== 'device' ||
            event.shiftKey ||
            event.ctrlKey ||
            event.metaKey ||
            (event.target as Element).closest('.react-flow__handle')
          )
            return;
          closeActions();
          onDeviceAction('inspect', node.id);
        }}
        onNodeContextMenu={(event, node) => {
          if (node.type !== 'device') return;
          event.preventDefault();
          event.stopPropagation();
          onSelect([node.id]);
          setActions({
            id: node.id,
            x: event.clientX,
            y: event.clientY,
            trigger: event.currentTarget as HTMLElement,
          });
        }}
        onNodeDoubleClick={(event, node) => {
          if (node.type !== 'device') return;
          event.preventDefault();
          event.stopPropagation();
          closeActions();
          onDeviceAction('inspect', node.id);
        }}
        onPaneClick={() => closeActions()}
        onNodeDragStart={() => closeActions()}
        onMoveStart={(event) => {
          if (event) closeActions();
        }}
        onConnect={view === 'physical' ? onConnect : undefined}
        nodesConnectable={view === 'physical'}
        nodesDraggable={view === 'physical'}
        onEdgeClick={(_e, edge) => onEdge(edge.id)}
        connectionMode={ConnectionMode.Loose}
        onNodesDelete={(deleted) =>
          lab.change((sim) => {
            for (const node of deleted) removeCanvasItem(sim, node.id);
          })
        }
        deleteKeyCode={view === 'physical' ? ['Backspace', 'Delete'] : null}
        selectionKeyCode="Shift"
        multiSelectionKeyCode="Shift"
        snapToGrid={engine.state.snapToGrid ?? true}
        snapGrid={[20, 20]}
        minZoom={0.15}
        maxZoom={2.5}
        zoomOnDoubleClick={false}
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
          <h2>Canvas vazio</h2>
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
        <span
          className={'canvas-run-status ' + (lab.playing ? 'is-playing' : 'is-paused')}
          aria-hidden="true"
        />{' '}
        {engine.state.devices.length} dispositivos <span>·</span> {engine.state.links.length} conexões{' '}
        <span>·</span> {engine.state.clock.toFixed(2)} ms
      </div>
      {actions && actionDevice && (
        <DeviceActions
          device={actionDevice}
          point={actions}
          bounds={container.current?.getBoundingClientRect()}
          canConnect={
            availablePorts(engine.state, actionDevice).length > 0 &&
            engine.state.devices.some(
              (entry) => entry.id !== actionDevice.id && availablePorts(engine.state, entry).length > 0
            )
          }
          canDuplicate={engine.state.devices.length < 2000}
          onAction={onDeviceAction}
          onClose={closeActions}
        />
      )}
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
