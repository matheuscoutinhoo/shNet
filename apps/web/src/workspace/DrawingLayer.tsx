import { useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { addDrawing } from '@shlab/engine';
import type { LabController } from './useLab';
export function DrawingLayer({ lab, onDone }: { lab: LabController; onDone: () => void }) {
  const { screenToFlowPosition } = useReactFlow();
  const points = useRef<{ x: number; y: number }[]>([]);
  const [preview, setPreview] = useState<{ x: number; y: number }[]>([]);
  return (
    <div
      className="drawing-layer"
      role="region"
      aria-label="Área de desenho livre"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onDone();
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        points.current = [screenToFlowPosition({ x: event.clientX, y: event.clientY })];
        const rect = event.currentTarget.getBoundingClientRect();
        setPreview([{ x: event.clientX - rect.left, y: event.clientY - rect.top }]);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId) || points.current.length >= 512) return;
        const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
        const last = points.current.at(-1)!;
        if (Math.hypot(point.x - last.x, point.y - last.y) < 2) return;
        points.current.push(point);
        const rect = event.currentTarget.getBoundingClientRect();
        setPreview((value) => [...value, { x: event.clientX - rect.left, y: event.clientY - rect.top }]);
      }}
      onPointerUp={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        if (points.current.length >= 2) lab.change((engine) => addDrawing(engine, points.current));
        points.current = [];
        setPreview([]);
        onDone();
      }}
      onPointerCancel={() => {
        points.current = [];
        setPreview([]);
        onDone();
      }}
    >
      <svg aria-hidden="true">
        <polyline
          points={preview.map((p) => p.x + ',' + p.y).join(' ')}
          fill="none"
          stroke="#217ddd"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
      <span className="drawing-hint">Arraste para desenhar. Escape cancela.</span>
    </div>
  );
}
