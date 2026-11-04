import { useMemo, useState } from 'react';
import { applyBulkConfig, parseVariableTable, renderTemplate, siteOf, type BulkResult } from '@shlab/engine';
import { Modal } from '../components/Modal';
import type { LabController } from './useLab';

const PRESETS: { name: string; template: string; variables?: string }[] = [
  {
    name: 'Gerência: NTP, syslog e SNMP',
    template: ['ntp server 10.0.0.10', 'logging host 10.0.0.20', 'snmp-server community {{site}}-RO RO'].join(
      '\n'
    ),
  },
  {
    name: 'Loopback de gerência anunciada no OSPF',
    template: [
      'interface Loopback0',
      ' description MGMT {{hostname}}',
      ' ip address {{loopback}} 255.255.255.255',
      'exit',
      'router ospf 1',
      ' network {{loopback}} 0.0.0.0 area 0',
    ].join('\n'),
    variables: 'hostname,loopback\nHQ-CORE-1,10.255.0.1\nHQ-CORE-2,10.255.0.2',
  },
  {
    name: 'VLANs padrão de acesso',
    template: ['vlan 10', ' name DATA', 'vlan 20', ' name VOICE', 'vlan 99', ' name MGMT'].join('\n'),
  },
];

export function BulkConfigDialog({
  lab,
  selected,
  onClose,
}: {
  lab: LabController;
  selected: string[];
  onClose: () => void;
}) {
  const candidates = lab.engine.state.devices
    .filter((d) => d.type === 'router' || d.type === 'switch')
    .sort((a, b) => a.hostname.localeCompare(b.hostname, 'en', { numeric: true }));
  const [filter, setFilter] = useState('');
  const [targets, setTargets] = useState<string[]>(() =>
    candidates.filter((d) => selected.includes(d.id)).map((d) => d.id)
  );
  const [template, setTemplate] = useState('');
  const [variables, setVariables] = useState('');
  const [results, setResults] = useState<BulkResult[] | null>(null);
  const visible = candidates.filter((d) => {
    const q = filter.trim().toLowerCase();
    return !q || d.hostname.toLowerCase().includes(q) || siteOf(d.hostname)?.toLowerCase() === q;
  });
  const ordered = candidates.filter((d) => targets.includes(d.id));
  const table = useMemo(() => {
    try {
      return { value: parseVariableTable(variables) };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }, [variables]);
  const preview = useMemo(() => {
    const first = ordered[0];
    if (!first || !template.trim() || !table.value) return '';
    try {
      return renderTemplate(template, {
        site: siteOf(first.hostname) ?? '',
        ...table.value.get(first.hostname.toLowerCase()),
        hostname: first.hostname,
        index: '1',
      });
    } catch (error) {
      return '% ' + (error as Error).message;
    }
  }, [ordered, template, table]);
  const applied = results?.filter((r) => r.status === 'applied').length ?? 0;
  return (
    <Modal title="Configuração em massa" onClose={onClose} wide>
      <p className="muted">
        Aplica o mesmo bloco de comandos, em modo de configuração global, a vários roteadores e switches. Cada
        equipamento é atômico: se uma linha falhar, nada é aplicado nele e a linha é indicada. Use{' '}
        <code>{'{{hostname}}'}</code>, <code>{'{{site}}'}</code>, <code>{'{{index}}'}</code> ou colunas da
        tabela de variáveis. Tudo vira um único passo de desfazer.
      </p>
      <div className="bulk-config">
        <section aria-label="Equipamentos de destino">
          <label>
            Filtrar por nome ou site
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="ex.: HQ ou CORE" />
          </label>
          <div className="bulk-actions">
            <button
              type="button"
              className="button small"
              onClick={() => setTargets((t) => [...new Set([...t, ...visible.map((d) => d.id)])])}
            >
              Marcar {visible.length} visíveis
            </button>
            <button type="button" className="button small" onClick={() => setTargets([])}>
              Limpar
            </button>
          </div>
          <ul className="bulk-targets">
            {visible.map((d) => (
              <li key={d.id}>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={targets.includes(d.id)}
                    onChange={(e) =>
                      setTargets((t) => (e.target.checked ? [...t, d.id] : t.filter((id) => id !== d.id)))
                    }
                  />{' '}
                  {d.hostname}{' '}
                  <small>{d.type === 'router' ? 'roteador' : d.ipRouting ? 'switch L3' : 'switch'}</small>
                </label>
              </li>
            ))}
          </ul>
          <p>{targets.length} selecionados</p>
        </section>
        <section aria-label="Modelo de configuração">
          <label>
            Modelo pronto
            <select
              value=""
              onChange={(e) => {
                const preset = PRESETS[Number(e.target.value)];
                if (!preset) return;
                setTemplate(preset.template);
                if (preset.variables && !variables.trim()) setVariables(preset.variables);
              }}
            >
              <option value="">Escolher…</option>
              {PRESETS.map((p, i) => (
                <option key={p.name} value={i}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Comandos
            <textarea
              className="code-input"
              rows={10}
              spellCheck={false}
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              placeholder={'interface Loopback0\n ip address {{loopback}} 255.255.255.255'}
            />
          </label>
          <label>
            Tabela de variáveis (opcional; primeira linha com a coluna hostname)
            <textarea
              className="code-input"
              rows={4}
              spellCheck={false}
              value={variables}
              onChange={(e) => setVariables(e.target.value)}
              placeholder={'hostname,loopback\nHQ-CORE-1,10.255.0.1'}
            />
          </label>
          {table.error && <p role="alert">{table.error}</p>}
          {preview && (
            <details open>
              <summary>Prévia para {ordered[0]?.hostname}</summary>
              <pre className="code-output">{preview}</pre>
            </details>
          )}
        </section>
      </div>
      <button
        className="button primary"
        disabled={!targets.length || !template.trim() || !!table.error}
        onClick={() => {
          const ids = ordered.map((d) => d.id);
          const outcome = lab.change(
            (engine) => applyBulkConfig(engine, ids, template, table.value),
            true,
            true,
            true
          );
          if (outcome) setResults(outcome);
        }}
      >
        Aplicar em {targets.length} equipamentos
      </button>
      {results && (
        <section aria-label="Resultado da configuração em massa">
          <p role="status">
            {applied} de {results.length} equipamentos configurados.
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th>Equipamento</th>
                <th>Resultado</th>
                <th>Detalhe</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.device} className={r.status === 'failed' ? 'row-error' : ''}>
                  <td>{r.hostname}</td>
                  <td>{r.status === 'applied' ? 'Aplicado' : 'Não aplicado'}</td>
                  <td>
                    {r.status === 'applied'
                      ? r.lines + ' linhas'
                      : (r.error?.number ? 'Linha ' + r.error.number + ' “' + r.error.line + '”: ' : '') +
                        r.error?.message}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </Modal>
  );
}
