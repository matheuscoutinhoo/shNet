import { useId, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Monitor,
  Network,
  Router,
  Wifi,
  ShieldCheck,
  Server,
  Waypoints,
  Cable,
} from 'lucide-react';
import type { DeviceProfile } from '@shlab/engine';
import { DeviceIcon } from '../components/DeviceIcon';
import { SearchField } from '../components/SearchField';
import { equipmentGroups, type EquipmentCategory } from './deviceCatalog';

const categoryIcons = {
  'Dispositivos finais': Monitor,
  Switches: Network,
  Roteadores: Router,
  Wireless: Wifi,
  Segurança: ShieldCheck,
  'Servidores e serviços': Server,
  'SD-WAN': Waypoints,
  Infraestrutura: Cable,
};

export function EquipmentCatalog({ onAdd }: { onAdd: (profile: DeviceProfile) => void }) {
  const [query, setQuery] = useState(''),
    [collapsed, setCollapsed] = useState(new Set<EquipmentCategory>());
  const prefix = useId();
  const groups = equipmentGroups(query);
  return (
    <>
      <SearchField
        label="Buscar equipamento"
        placeholder="Buscar equipamento…"
        value={query}
        onChange={(value) => {
          setQuery(value);
          setCollapsed(new Set());
        }}
      />
      <p className="panel-description">Arraste para o canvas ou clique para adicionar.</p>
      <div className="equipment-categories">
        {groups.map(({ category, profiles }) => {
          const Icon = categoryIcons[category],
            expanded = !collapsed.has(category);
          const id = prefix + '-' + category.replaceAll(' ', '-');
          return (
            <section className="equipment-category" key={category} aria-label={category}>
              <button
                className="catalog-category-toggle"
                aria-expanded={expanded}
                aria-controls={id}
                onClick={() =>
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(category)) next.delete(category);
                    else next.add(category);
                    return next;
                  })
                }
              >
                <Icon size={17} aria-hidden="true" />
                <span>{category}</span>
                <span className="count">{profiles.length}</span>
                {expanded ? (
                  <ChevronDown size={15} aria-hidden="true" />
                ) : (
                  <ChevronRight size={15} aria-hidden="true" />
                )}
              </button>
              <div id={id} hidden={!expanded}>
                {profiles.map((profile) => (
                  <button
                    key={profile.id}
                    className="equipment-card"
                    title={profile.description}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData('application/shlab-profile', profile.id);
                      event.dataTransfer.effectAllowed = 'copy';
                    }}
                    onClick={() => onAdd(profile)}
                  >
                    <span>
                      <DeviceIcon profile={profile.id} type={profile.type} size={35} />
                    </span>
                    <div>
                      <strong>{profile.name}</strong>
                      <small>{profile.role}</small>
                    </div>
                    <Plus size={15} aria-hidden="true" />
                  </button>
                ))}
              </div>
            </section>
          );
        })}
        {!groups.length && (
          <p className="catalog-empty" role="status">
            Nenhum equipamento encontrado.
          </p>
        )}
      </div>
    </>
  );
}
