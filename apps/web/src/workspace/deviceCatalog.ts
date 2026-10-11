import { deviceProfiles, type DeviceProfile, type Device, type Snapshot } from '@shlab/engine';
import { searchText } from '../catalog';

export const equipmentCategories = [
  'Dispositivos finais',
  'Switches',
  'Roteadores',
  'Wireless',
  'Segurança',
  'Servidores e serviços',
  'SD-WAN',
  'Infraestrutura',
] as const;
export type EquipmentCategory = (typeof equipmentCategories)[number];

export function equipmentCategory(profile: DeviceProfile): EquipmentCategory {
  if (profile.category === 'Endpoints') return 'Dispositivos finais';
  if (profile.category === 'Switching') return 'Switches';
  if (profile.category === 'Routing' || profile.category === 'Redes virtuais') return 'Roteadores';
  if (profile.category === 'Serviços') return 'Servidores e serviços';
  return profile.category as EquipmentCategory;
}

export function equipmentGroups(query = '') {
  const term = searchText(query);
  return equipmentCategories
    .map((category) => ({
      category,
      profiles: deviceProfiles.filter(
        (profile) =>
          equipmentCategory(profile) === category &&
          searchText([profile.name, profile.role, profile.description, category].join(' ')).includes(term)
      ),
    }))
    .filter((group) => group.profiles.length);
}

export function availablePorts(snapshot: Snapshot, device: Device) {
  return device.interfaces.filter(
    (port) =>
      !port.logical &&
      !port.aggregate &&
      !port.tunnel &&
      !port.vxlan &&
      !port.capwapPeer &&
      !port.meshPeer &&
      port.media !== 'wifi' &&
      !snapshot.links.some((link) =>
        [link.a, link.b].some((end) => end.device === device.id && end.port === port.id)
      )
  );
}
