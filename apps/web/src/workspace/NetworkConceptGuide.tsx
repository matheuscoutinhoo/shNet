import { useId, useState } from 'react';
import { labs, type LabId } from '@shlab/engine';
import { conceptsForLab, type ConceptId } from './networkConcepts';

export function NetworkConceptGuide({
  mode,
  labId,
}: {
  mode: 'free' | 'guided' | 'challenge';
  labId: LabId | null;
}) {
  const available = conceptsForLab(mode, labId);
  const [selected, setSelected] = useState<ConceptId>(available[0].id);
  const topic = available.find((entry) => entry.id === selected) ?? available[0];
  const titleId = useId();
  const definition = labs.find((entry) => entry.id === labId);
  return (
    <section className="learning-card concept-guide" aria-labelledby={titleId}>
      <h3 id={titleId}>Conceitos de rede</h3>
      <p className="muted">
        {mode === 'free'
          ? 'Todos os conceitos estão disponíveis para consulta no modo livre.'
          : 'Conceitos envolvidos em ' + (definition?.name ?? 'seu laboratório') + '.'}
      </p>
      <label>
        Conceito de rede
        <select value={topic.id} onChange={(event) => setSelected(event.target.value as ConceptId)}>
          {available.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>
      <article className="concept-content" aria-label={topic.name}>
        <h4>{topic.name}</h4>
        <p>{topic.explanation}</p>
        <div className="concept-example">
          <strong>Exemplo</strong>
          <p>{topic.example}</p>
        </div>
        <h5>Como observar no laboratório</h5>
        <ol>
          {topic.observe.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <details>
          <summary>Neste simulador</summary>
          <p className="muted">{topic.model}</p>
        </details>
      </article>
    </section>
  );
}
