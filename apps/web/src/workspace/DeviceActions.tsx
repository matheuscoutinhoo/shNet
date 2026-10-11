import { deviceCapabilities } from './deviceCapabilities';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Settings2, Pencil, Copy, Cable, Power, Trash2, X } from 'lucide-react';
import type { Device } from '@shlab/engine';

export type DeviceAction = 'inspect' | 'rename' | 'duplicate' | 'connect' | 'power' | 'delete';

export function DeviceActions({
  device,
  point,
  bounds,
  canConnect,
  canDuplicate,
  onAction,
  onClose,
}: {
  device: Device;
  point: { x: number; y: number };
  bounds: DOMRect | undefined;
  canConnect: boolean;
  canDuplicate: boolean;
  onAction: (action: DeviceAction, id: string) => void;
  onClose: (restoreFocus?: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: point.x, top: point.y });
  const capabilities = deviceCapabilities(device);
  const items = [
    { id: 'inspect', label: 'Inspecionar', icon: Settings2 },
    { id: 'rename', label: 'Renomear', icon: Pencil },
    { id: 'duplicate', label: 'Duplicar', icon: Copy, disabled: !canDuplicate },
    { id: 'connect', label: 'Conectar', icon: Cable, disabled: !canConnect },
    {
      id: 'power',
      label: device.power ? 'Desligar' : 'Ligar',
      icon: Power,
      disabled: device.infrastructure?.kind === 'patch-panel',
    },
    { id: 'delete', label: 'Excluir', icon: Trash2 },
  ] as const;
  const applicableItems = items.filter(
    (item) =>
      (item.id !== 'power' || capabilities.power) &&
      (item.id !== 'connect' || (capabilities.ports && device.interfaces.some((p) => p.media !== 'wifi')))
  );
  useLayoutEffect(() => {
    const menu = ref.current!;
    const width = menu.offsetWidth,
      height = menu.offsetHeight;
    const leftBound = bounds && bounds.width >= width + 16 ? bounds.left + 8 : 8;
    const rightBound = bounds && bounds.width >= width + 16 ? bounds.right - 8 : window.innerWidth - 8;
    setPosition({
      left: Math.max(leftBound, Math.min(point.x + 10, rightBound - width)),
      top: Math.max(8, Math.min(point.y + 8, window.innerHeight - height - 8)),
    });
    menu.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [point.x, point.y, bounds?.left, bounds?.right, bounds?.width]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const resize = () => onClose();
    document.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('resize', resize);
    };
  }, [onClose]);
  return createPortal(
    <div
      className="device-actions-popover"
      role="region"
      aria-label={'Opções do equipamento ' + device.hostname}
      ref={ref}
      style={position}
      onKeyDown={(event) => {
        const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape', 'Tab'];
        if (!keys.includes(event.key)) return;
        event.stopPropagation();
        if (event.key === 'Tab') {
          onClose(true);
          return;
        }
        event.preventDefault();
        if (event.key === 'Escape') {
          onClose(true);
          return;
        }
        const buttons = [
          ...ref.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'),
        ];
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const index =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[index]?.focus();
      }}
    >
      <div className="device-actions-heading">
        <strong>{device.hostname}</strong>
        <button
          className="icon-button"
          aria-label="Fechar ações do equipamento"
          onClick={() => onClose(true)}
        >
          <X size={16} />
        </button>
      </div>
      <div role="menu" aria-label={'Ações de ' + device.hostname}>
        {applicableItems.map((item) => (
          <button
            key={item.id}
            role="menuitem"
            tabIndex={-1}
            className={'device-action ' + (item.id === 'delete' ? 'danger' : '')}
            disabled={'disabled' in item && item.disabled}
            onClick={() => {
              onClose(true);
              onAction(item.id, device.id);
            }}
          >
            <item.icon size={17} aria-hidden="true" />
            {item.label}
          </button>
        ))}
      </div>
      <small>↑ ↓ para navegar · Esc para fechar</small>
    </div>,
    document.body
  );
}
