import { useState } from 'react';
import { EXAMS, examCoverage, type ExamId } from '@shlab/engine/catalog';
import { labs, templates, type LabId, type TemplateId } from '@shlab/engine/catalog';
import { Modal } from './components/Modal';

const names = new Map<string, { name: string; kind: 'template' | 'lesson' }>([
  ...templates.map((t) => [t.id, { name: t.name, kind: 'template' as const }] as const),
  ...labs.map((l) => [l.id, { name: l.name, kind: 'lesson' as const }] as const),
]);

/** Exam blueprint with the templates and guided labs that exercise each topic. */
export function ExamMap({
  onClose,
  onTemplate,
  onLesson,
}: {
  onClose: () => void;
  onTemplate: (id: TemplateId) => void;
  onLesson: (id: LabId) => void;
}) {
  const [exam, setExam] = useState<ExamId>('ccna');
  const coverage = examCoverage(exam);
  const covered = coverage.filter((row) => row.items.length).length;
  const domains = [...new Set(coverage.map((row) => row.domain))];
  return (
    <Modal title="Mapa de estudo CCNA/CCNP" onClose={onClose} wide>
      <p className="muted">
        Tópicos oficiais da prova (em inglês, como publicados pela Cisco) e os templates ou trilhas que os
        exercitam no simulador. Confira a versão vigente do blueprint antes de agendar a prova.
      </p>
      <div className="exam-tabs" role="tablist" aria-label="Certificação">
        {(Object.keys(EXAMS) as ExamId[]).map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={exam === id}
            className={'button small' + (exam === id ? ' primary' : '')}
            onClick={() => setExam(id)}
          >
            {EXAMS[id].name} {EXAMS[id].code} {EXAMS[id].version}
          </button>
        ))}
      </div>
      <p role="status" className="exam-summary">
        {covered} de {coverage.length} tópicos com template ou trilha.
      </p>
      {domains.map((domain) => (
        <section key={domain} className="exam-domain">
          <h3>{domain}</h3>
          <table className="exam-table">
            <tbody>
              {coverage
                .filter((row) => row.domain === domain)
                .map(({ topic, items }) => (
                  <tr key={topic.id} className={items.length ? '' : 'uncovered'}>
                    <th scope="row">{topic.number}</th>
                    <td>{topic.title}</td>
                    <td>
                      {items.length ? (
                        items.map((id) => {
                          const item = names.get(id)!;
                          return (
                            <button
                              key={id}
                              className="exam-link"
                              onClick={() =>
                                item.kind === 'template'
                                  ? onTemplate(id as TemplateId)
                                  : onLesson(id as LabId)
                              }
                            >
                              {item.name}
                            </button>
                          );
                        })
                      ) : (
                        <span className="muted">Ainda sem template ou trilha</span>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      ))}
    </Modal>
  );
}
