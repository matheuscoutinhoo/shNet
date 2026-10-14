import { scenarioSchema, type Snapshot, type Scenario } from '@shlab/engine';
import { ConfigEditor } from '../components/ConfigEditor';
export function ScenarioForm({
  text,
  setText,
  snapshot,
}: {
  text: string;
  setText: (value: string) => void;
  snapshot: Snapshot;
}) {
  let draft: Scenario;
  try {
    draft = JSON.parse(text);
    if (!Array.isArray(draft.flows)) return null;
  } catch {
    return <p>Corrija o JSON para abrir o formulário.</p>;
  }
  const edit = (fn: (draft: Scenario) => void) => {
    const copy = structuredClone(draft);
    fn(copy);
    setText(JSON.stringify(copy, null, 2));
  };
  return (
    <div className="scenario-form">
      <label>
        Nome do ensaio{' '}
        <input
          value={draft.name ?? ''}
          maxLength={100}
          onChange={(e) =>
            edit((s) => {
              s.name = e.target.value;
            })
          }
        />
      </label>
      {(['durationMs', 'intervalMs', 'deadlineMs'] as const).map((key) => (
        <label key={key}>
          {{ durationMs: 'Duração (ms)', intervalMs: 'Intervalo (ms)', deadlineMs: 'Deadline (ms)' }[key]}{' '}
          <input
            type="number"
            min={1}
            value={draft[key] ?? 1000}
            onChange={(e) =>
              edit((s) => {
                s[key] = Number(e.target.value);
              })
            }
          />
        </label>
      ))}
      <label>
        Aquecimento / convergência (ms){' '}
        <input
          type="number"
          min={0}
          max={60000}
          value={draft.warmupMs ?? 0}
          onChange={(e) =>
            edit((s) => {
              s.warmupMs = Number(e.target.value);
            })
          }
        />
      </label>
      {draft.flows.map((f, i) => (
        <fieldset key={i}>
          <legend>Fluxo {i + 1}</legend>
          <label>
            Nome{' '}
            <input
              value={f.name}
              onChange={(e) =>
                edit((s) => {
                  s.flows[i].name = e.target.value;
                })
              }
            />
          </label>
          <label>
            Origem{' '}
            <select
              value={snapshot.devices.find((d) => d.id === f.source)?.hostname ?? f.source}
              onChange={(e) =>
                edit((s) => {
                  s.flows[i].source = e.target.value;
                })
              }
            >
              {snapshot.devices.map((d) => (
                <option key={d.id} value={d.hostname}>
                  {d.hostname}
                </option>
              ))}
            </select>
          </label>
          <label>
            IPv4 ou IPv6 de destino{' '}
            <input
              value={f.target}
              onChange={(e) =>
                edit((s) => {
                  s.flows[i].target = e.target.value;
                })
              }
            />
          </label>
          <label>
            Protocolo{' '}
            <select
              aria-label="Protocolo"
              value={f.protocol}
              onChange={(e) =>
                edit((s) => {
                  const flow = s.flows[i];
                  for (const key of [
                    'modbus',
                    'dns',
                    'dhcp',
                    'mqtt',
                    'snmp',
                    'ntp',
                    'syslog',
                    'expectedRegisters',
                    'expectedBits',
                  ] as const)
                    delete flow[key];
                  flow.protocol = e.target.value as Scenario['flows'][number]['protocol'];
                  if (flow.protocol === 'modbus')
                    flow.modbus = {
                      transaction: 1,
                      unit: 1,
                      function: 3,
                      address: 0,
                      quantity: 1,
                      values: [],
                    };
                  if (flow.protocol === 'dns')
                    flow.dns = { name: 'erp.example.test', type: 'A', clearCache: true };
                  if (flow.protocol === 'dhcp')
                    flow.dhcp = {
                      interface:
                        snapshot.devices.find((d) => d.id === flow.source || d.hostname === flow.source)
                          ?.interfaces[0]?.id ?? 'p0',
                      fresh: true,
                    };
                  if (flow.protocol === 'mqtt') flow.mqtt = { operation: 'connect', retain: false };
                  if (flow.protocol === 'snmp')
                    flow.snmp = { community: 'public', oids: ['1.3.6.1.2.1.1.1.0'], operation: 'get' };
                  if (flow.protocol === 'ntp') flow.ntp = { maxOffsetMs: 1 };
                  if (flow.protocol === 'syslog')
                    flow.syslog = { text: 'Teste de conectividade', severity: 6 };
                })
              }
            >
              {scenarioSchema.shape.flows.element.shape.protocol.options.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <details>
            <summary>Parâmetros e critérios do fluxo {i + 1}</summary>
            <ConfigEditor
              structuredOnly
              label={'Configuração do fluxo ' + (i + 1)}
              schema={scenarioSchema.shape.flows.element}
              value={JSON.stringify(f)}
              choices={{
                source: snapshot.devices.map((d) => ({ value: d.hostname, label: d.hostname })),
                receiver: snapshot.devices.map((d) => ({ value: d.hostname, label: d.hostname })),
              }}
              onChange={(event) => {
                try {
                  const value = JSON.parse(event.target.value);
                  edit((s) => {
                    s.flows[i] = value;
                  });
                } catch {
                  /* The JSON editor preserves invalid text locally. */
                }
              }}
            />
          </details>
          <label>
            VRF (vazio = padrão){' '}
            <input
              value={f.vrf ?? ''}
              onChange={(e) =>
                edit((s) => {
                  s.flows[i].vrf = e.target.value || undefined;
                })
              }
            />
          </label>
          <label>
            Escopo IPv6 (ID da interface){' '}
            <input
              value={f.scope ?? ''}
              onChange={(e) =>
                edit((s) => {
                  s.flows[i].scope = e.target.value || undefined;
                })
              }
            />
          </label>
          <label>
            Resultado esperado{' '}
            <select
              value={f.expect}
              onChange={(e) =>
                edit((s) => {
                  s.flows[i].expect = e.target.value as 'allow' | 'deny';
                })
              }
            >
              <option value="allow">Permitir</option>
              <option value="deny">Negar</option>
            </select>
          </label>
          {f.expect === 'deny' && (
            <label>
              Evidência exigida{' '}
              <select
                value={f.denyEvidence ?? 'no-response'}
                onChange={(e) =>
                  edit((s) => {
                    s.flows[i].denyEvidence = e.target.value as 'no-response' | 'policy';
                  })
                }
              >
                <option value="policy">Regra de política correlacionada</option>
                <option value="no-response">Ausência de resposta</option>
              </select>
            </label>
          )}
          <label>
            Perda máxima (%){' '}
            <input
              type="number"
              min={0}
              max={100}
              value={f.maxLossPercent ?? 0}
              onChange={(e) =>
                edit((s) => {
                  s.flows[i].maxLossPercent = Number(e.target.value);
                })
              }
            />
          </label>
          <button
            className="button small"
            onClick={() =>
              edit((s) => {
                s.flows.splice(i, 1);
              })
            }
          >
            Remover fluxo
          </button>
        </fieldset>
      ))}
      <button
        className="button"
        onClick={() =>
          edit((s) => {
            s.flows.push({
              name: 'Fluxo ' + (s.flows.length + 1),
              source: snapshot.devices[0]?.hostname ?? '',
              target: '192.0.2.1',
              protocol: 'icmp',
              expect: 'allow',
              maxLossPercent: 0,
              requireFinalSuccess: true,
            });
          })
        }
      >
        Adicionar fluxo
      </button>
      {(draft.faults ?? []).map((f, i) => (
        <fieldset key={i}>
          <legend>
            Falha {i + 1}: {f.kind}
          </legend>
          <ConfigEditor
            structuredOnly
            label={'Configuração da falha ' + (i + 1)}
            schema={scenarioSchema.shape.faults.element}
            value={JSON.stringify(f)}
            onChange={(event) => {
              try {
                const value = JSON.parse(event.target.value);
                edit((s) => {
                  s.faults[i] = value;
                });
              } catch {
                /* Use the main JSON editor for syntax corrections. */
              }
            }}
          />
          <label>
            Instante (ms){' '}
            <input
              type="number"
              min={0}
              value={f.atMs}
              onChange={(e) =>
                edit((s) => {
                  s.faults[i].atMs = Number(e.target.value);
                })
              }
            />
          </label>
          <label>
            Alvo (nome/ID){' '}
            <input
              value={f.target}
              onChange={(e) =>
                edit((s) => {
                  s.faults[i].target = e.target.value;
                })
              }
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={f.up}
              onChange={(e) =>
                edit((s) => {
                  s.faults[i].up = e.target.checked;
                })
              }
            />
            Restaurar disponibilidade
          </label>
          <button
            className="button small"
            onClick={() =>
              edit((s) => {
                s.faults.splice(i, 1);
              })
            }
          >
            Remover falha
          </button>
        </fieldset>
      ))}
      <button
        className="button"
        onClick={() =>
          edit((s) => {
            s.faults ??= [];
            s.faults.push({
              atMs: 2000,
              target: snapshot.devices[0]?.hostname ?? '',
              kind: 'device',
              up: false,
            });
          })
        }
      >
        Adicionar falha de equipamento
      </button>
      <ConfigEditor
        structuredOnly
        label="Ações agendadas"
        schema={scenarioSchema.shape.actions}
        value={JSON.stringify(draft.actions ?? [])}
        choices={{ device: snapshot.devices.map((d) => ({ value: d.id, label: d.hostname })) }}
        onChange={(event) => {
          try {
            const value = JSON.parse(event.target.value);
            edit((s) => {
              s.actions = value;
            });
          } catch {
            /* Use the main JSON editor for syntax corrections. */
          }
        }}
      />
      <ConfigEditor
        structuredOnly
        label="Verificações de estado"
        schema={scenarioSchema.shape.assertions}
        value={JSON.stringify(draft.assertions ?? [])}
        choices={{ device: snapshot.devices.map((d) => ({ value: d.id, label: d.hostname })) }}
        onChange={(event) => {
          try {
            const value = JSON.parse(event.target.value);
            edit((s) => {
              s.assertions = value;
            });
          } catch {
            /* Use the main JSON editor for syntax corrections. */
          }
        }}
      />
      <p className="muted">
        Os limites são critérios deste ensaio. Defina o SLA de produção por fluxo. Edite parâmetros avançados
        de serviço, portas, enlaces e alimentação nos formulários ou no JSON abaixo. Configure aplica uma
        proposta validada; rollback reverte somente os campos alterados, sem retroceder o relógio.
        Checkpoint/restore restaura a simulação inteira.
      </p>
    </div>
  );
}
