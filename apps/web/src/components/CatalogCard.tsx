import { ArrowUpRight, BookOpen, Network } from 'lucide-react';
import type { ExamId } from '@shlab/engine/catalog';
import { ExamChips } from './ExamChips';

export function CatalogCard({
  id,
  exam,
  kind,
  name,
  meta,
  description,
  onOpen,
}: {
  /** Template or lab id, for its exam topics. */
  id?: string;
  exam?: ExamId;
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
      {id && <ExamChips id={id} exam={exam} />}
      <span className="catalog-action">
        {kind === 'lesson' ? 'Abrir trilha' : 'Usar template'} <ArrowUpRight size={16} aria-hidden="true" />
      </span>
    </button>
  );
}
