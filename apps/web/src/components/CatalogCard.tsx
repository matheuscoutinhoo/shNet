import { ArrowUpRight, BookOpen, Network } from 'lucide-react';

export function CatalogCard({
  kind,
  name,
  meta,
  description,
  onOpen,
}: {
  kind: 'template' | 'lesson';
  name: string;
  meta: string;
  description: string;
  onOpen: () => void;
}) {
  const Icon = kind === 'lesson' ? BookOpen : Network;
  return (
    <button className={`catalog-card ${kind}-card`} onClick={onOpen}>
      <span className="catalog-icon">
        <Icon size={23} aria-hidden="true" />
      </span>
      <span className="catalog-meta">{meta}</span>
      <h3 title={name}>{name}</h3>
      <p title={description}>{description}</p>
      <span className="catalog-action">
        {kind === 'lesson' ? 'Abrir trilha' : 'Usar template'} <ArrowUpRight size={16} aria-hidden="true" />
      </span>
    </button>
  );
}
