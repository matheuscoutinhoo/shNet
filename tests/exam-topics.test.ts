import { describe, expect, it } from 'vitest';
import {
  EXAMS,
  EXAM_DOMAINS,
  EXAM_MAP,
  EXAM_TOPICS,
  examCoverage,
  examTopicsFor,
  labs,
  templates,
  type ExamId,
} from '../packages/simulation-engine/src/catalog';

describe('CCNA/CCNP exam topic map', () => {
  it('maps only existing templates, labs and topics', () => {
    const items = new Set<string>([...templates.map((t) => t.id), ...labs.map((l) => l.id)]);
    const topics = new Set(EXAM_TOPICS.map((t) => t.id));
    for (const [id, list] of Object.entries(EXAM_MAP)) {
      expect(items.has(id), id).toBe(true);
      for (const topic of list!) expect(topics.has(topic), id + ' → ' + topic).toBe(true);
      expect(new Set(list).size, id + ' has duplicate topics').toBe(list!.length);
    }
    expect(topics.size).toBe(EXAM_TOPICS.length);
  });

  it('every guided lab is mapped to at least one exam topic', () => {
    for (const lab of labs) expect(examTopicsFor(lab.id).length, lab.id).toBeGreaterThan(0);
  });

  it('lists every blueprint topic under a domain, with the labs that cover it', () => {
    for (const exam of Object.keys(EXAMS) as ExamId[])
      for (const row of examCoverage(exam))
        expect(row.domain, row.topic.id).toBe(EXAM_DOMAINS[exam][row.topic.number.split('.')[0]]);
    const ccna = examCoverage('ccna');
    expect(ccna).toHaveLength(53);
    expect(ccna.find((row) => row.topic.number === '3.4')!.items).toEqual(
      expect.arrayContaining(['ospf', 'ospf-repair'])
    );
    // Most CCNA topics have hands-on coverage; the rest are descriptive-only topics.
    expect(ccna.filter((row) => row.items.length).length).toBeGreaterThanOrEqual(40);
  });

  it('returns topics in blueprint order and filters by exam', () => {
    expect(examTopicsFor('ospf').map((t) => t.id)).toEqual([
      'ccna-3.1',
      'ccna-3.2',
      'ccna-3.4',
      'encor-3.2.a',
      'encor-3.2.b',
      'enarsi-1.10',
    ]);
    expect(examTopicsFor('ospf', 'encor').map((t) => t.number)).toEqual(['3.2.a', '3.2.b']);
    expect(examTopicsFor('quorum')).toEqual([]);
  });
});
