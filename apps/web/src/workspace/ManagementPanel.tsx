import { RemotePanel } from './RemotePanel';
import type { Device } from '@shlab/engine';
import type { LabController } from './useLab';
import { SnmpPanel } from './SnmpPanel';
import { SyslogPanel } from './SyslogPanel';
export function ManagementPanel({ lab, device }: { lab: LabController; device: Device }) {
  return (
    <div className="management-panel">
      <RemotePanel lab={lab} device={device} />
      <SnmpPanel lab={lab} device={device} />
      <SyslogPanel lab={lab} device={device} />
    </div>
  );
}
