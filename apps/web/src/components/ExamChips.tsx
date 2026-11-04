import { EXAMS, examTopicsFor, type ExamId } from '@shlab/engine/catalog';

/** Short exam-topic chips ("CCNA 3.4"); the official topic title is the tooltip. */
export function ExamChips({ id, exam, limit = 4 }: { id: string; exam?: ExamId; limit?: number }) {
  const topics = examTopicsFor(id, exam);
  if (!topics.length) return null;
  return (
    <span className="exam-chips">
      {topics.slice(0, limit).map((topic) => (
        <span
          key={topic.id}
          className={'exam-chip exam-' + topic.exam}
          title={EXAMS[topic.exam].name + ' ' + topic.number + ' — ' + topic.title}
        >
          {EXAMS[topic.exam].name.replace('CCNP ', '')} {topic.number}
        </span>
      ))}
      {topics.length > limit && <span className="exam-chip more">+{topics.length - limit}</span>}
    </span>
  );
}
