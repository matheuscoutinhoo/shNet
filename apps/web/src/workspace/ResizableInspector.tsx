import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export function ResizableInspector({
  width,
  onWidth,
  children,
}: {
  width: number;
  onWidth: (width: number) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [maximum, setMaximum] = useState(width);
  const [resizing, setResizing] = useState(false);
  useLayoutEffect(() => {
    const parent = ref.current!.parentElement!;
    const measure = () => {
      const catalog = parent.querySelector<HTMLElement>('.equipment-panel')?.offsetWidth ?? 0;
      const available =
        window.innerWidth <= 700 ? parent.clientWidth - 8 : parent.clientWidth - catalog - 240;
      setMaximum(Math.max(200, Math.min(900, available)));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    const catalog = parent.querySelector<HTMLElement>('.equipment-panel');
    if (catalog) observer.observe(catalog);
    const canvas = parent.querySelector<HTMLElement>('.canvas-and-timeline');
    if (canvas) observer.observe(canvas);
    measure();
    return () => observer.disconnect();
  }, []);
  const minimum = Math.min(280, maximum);
  const actual = Math.max(minimum, Math.min(maximum, width));
  const update = (next: number) => onWidth(Math.max(minimum, Math.min(maximum, next)));
  return (
    <aside
      ref={ref}
      className={'inspector' + (resizing ? ' resizing' : '')}
      aria-label="Inspeção de equipamento"
      style={{ width: actual }}
    >
      <div
        className="inspector-resize-handle"
        role="separator"
        tabIndex={0}
        aria-label="Redimensionar detalhes do equipamento"
        aria-orientation="vertical"
        aria-valuemin={Math.round(minimum)}
        aria-valuemax={Math.round(maximum)}
        aria-valuenow={Math.round(actual)}
        aria-valuetext={Math.round(actual) + ' pixels'}
        title="Arraste para a esquerda para expandir. Use ← e → pelo teclado."
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, width: actual };
          setResizing(true);
        }}
        onPointerMove={(event) => {
          if (drag.current) update(drag.current.width + drag.current.x - event.clientX);
        }}
        onPointerUp={(event) => {
          drag.current = null;
          setResizing(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => {
          drag.current = null;
          setResizing(false);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setResizing(false);
        }}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          update(
            event.key === 'Home'
              ? minimum
              : event.key === 'End'
                ? maximum
                : actual + (event.key === 'ArrowLeft' ? 32 : -32)
          );
        }}
      >
        <span />
      </div>
      {children}
    </aside>
  );
}
