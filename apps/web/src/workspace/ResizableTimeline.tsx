import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export function ResizableTimeline({ children }: { children: ReactNode }) {
  const id = useId();
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{ pointer: number; y: number; height: number } | null>(null);
  const [height, setHeight] = useState<number>();
  const [limits, setLimits] = useState({ minimum: 180, maximum: 238 });
  const [resizing, setResizing] = useState(false);
  useLayoutEffect(() => {
    const panel = ref.current!;
    const parent = panel.parentElement!;
    const measure = () => {
      const available = parent.clientHeight;
      const maximum = Math.max(0, available - Math.min(160, available * 0.25));
      setLimits({ minimum: Math.min(available >= 400 ? 180 : 140, maximum), maximum });
    };
    setHeight(panel.getBoundingClientRect().height);
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    measure();
    return () => observer.disconnect();
  }, []);
  const actual = Math.max(limits.minimum, Math.min(limits.maximum, height ?? 238));
  const update = (next: number) => setHeight(Math.max(limits.minimum, Math.min(limits.maximum, next)));
  const stop = () => {
    drag.current = null;
    setResizing(false);
  };
  return (
    <section
      id={id}
      ref={ref}
      className={'timeline' + (resizing ? ' resizing' : '')}
      aria-label="Eventos e tráfego do laboratório"
      style={height === undefined ? undefined : { height: actual }}
    >
      <div
        className="timeline-resize-handle"
        role="separator"
        tabIndex={0}
        aria-label="Redimensionar painel de eventos e tráfego"
        aria-controls={id}
        aria-orientation="horizontal"
        aria-valuemin={Math.round(limits.minimum)}
        aria-valuemax={Math.round(limits.maximum)}
        aria-valuenow={Math.round(actual)}
        aria-valuetext={Math.round(actual) + ' pixels de altura'}
        title="Arraste para cima para expandir. Use ↑ e ↓ pelo teclado; Home reduz e End expande."
        onPointerDown={(event) => {
          if (event.button !== 0 || drag.current) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { pointer: event.pointerId, y: event.clientY, height: actual };
          setResizing(true);
        }}
        onPointerMove={(event) => {
          if (drag.current?.pointer === event.pointerId)
            update(drag.current.height + drag.current.y - event.clientY);
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointer !== event.pointerId) return;
          stop();
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={stop}
        onPointerCancel={stop}
        onKeyDown={(event) => {
          if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          update(
            event.key === 'Home'
              ? limits.minimum
              : event.key === 'End'
                ? limits.maximum
                : actual + (event.key === 'ArrowUp' ? 32 : -32)
          );
        }}
      >
        <span />
      </div>
      {children}
    </section>
  );
}
