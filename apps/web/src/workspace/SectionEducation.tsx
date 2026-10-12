import { sectionLesson } from './educationalContent';
import type { Device } from '@shlab/engine';
export function SectionEducation({ section, device }: { section: string; device?: Device }) {
  const lesson = sectionLesson(section, device);
  if (!lesson) return null;
  return (
    <section className="section-education" aria-label="Entenda este painel">
      <p>{lesson.purpose}</p>
      <details>
        <summary>Como ler os campos e testar</summary>
        <dl>
          {lesson.fields.map(([label, meaning]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{meaning}</dd>
            </div>
          ))}
        </dl>
        <p>
          <strong>Experimente:</strong> {lesson.observe}
        </p>
      </details>
    </section>
  );
}
