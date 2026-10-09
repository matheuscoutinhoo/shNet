import { useId, useState, type TextareaHTMLAttributes } from 'react';
import { z } from 'zod';
import type { Device, SimulationEngine } from '@shlab/engine';
type Choice = { value: string; label: string };
export function configChoices(engine: SimulationEngine, device: Device) {
  const ports = device.interfaces.map((p) => ({ value: p.id, label: p.name }));
  return {
    port: ports,
    underlay: ports,
    delegatePort: ports,
    device: engine.state.devices.map((d) => ({ value: d.id, label: d.hostname })),
  };
}
type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value' | 'defaultValue'> & {
  label: string;
  value?: string;
  defaultValue?: string;
  schema?: z.ZodType;
  onChange?: (event: { target: { value: string } }) => void;
  choices?: Record<string, Choice[]>;
};
const labels: Record<string, string> = {
  enabled: 'Habilitado',
  port: 'Porta',
  device: 'Equipamento',
  name: 'Nome',
  kind: 'Tipo',
  key: 'Chave',
  password: 'Senha',
  username: 'Usuário',
  users: 'Usuários',
  clients: 'Clientes',
  protocol: 'Protocolo',
  rules: 'Regras',
  mode: 'Modo',
  priority: 'Prioridade',
  network: 'Rede',
  prefix: 'Prefixo',
  source: 'Origem',
  destination: 'Destino',
  destinationPort: 'Porta de destino',
  action: 'Ação',
  threshold: 'Limiar de pacotes',
  windowMs: 'Janela (ms)',
  synOnly: 'Somente SYN',
  pattern: 'Assinatura',
  allowedNetworks: 'Destinos permitidos',
  backends: 'Servidores de destino',
  address: 'Endereço',
  underlay: 'Interface de transporte',
  profiles: 'Perfis WLAN',
  ssid: 'SSID',
  vlan: 'VLAN',
  root: 'Raiz',
  maxDistance: 'Distância máxima (m)',
  meshId: 'Identidade mesh',
  interfaces: 'Interfaces',
  areas: 'Áreas',
  externalRoutes: 'Rotas externas',
  routerId: 'Router ID',
  cost: 'Custo',
  metric: 'Métrica',
  holdDownMs: 'Hold-down (ms)',
  pools: 'Pools',
  addresses: 'Endereços',
  start: 'Início',
  end: 'Fim',
  dns: 'Servidores DNS',
  validMs: 'Validade (ms)',
  preferredMs: 'Preferência (ms)',
  t1Ms: 'Renovação T1 (ms)',
  t2Ms: 'Rebinding T2 (ms)',
  rapidCommit: 'Rapid Commit',
  delegatePort: 'Interface de delegação',
  requestAddress: 'Solicitar endereço',
  requestPrefix: 'Solicitar prefixo',
  validation: 'Validação',
  anchors: 'Âncoras de confiança',
  zones: 'Zonas',
  ednsSize: 'Buffer EDNS',
  supply: 'Fornecedor PoE',
  load: 'Carga PoE',
  budget: 'Orçamento (W)',
  watts: 'Consumo (W)',
  standard: 'Padrão',
  required: 'Obrigatório',
  class: 'Classe',
  ports: 'Portas',
  body: 'Resposta',
  algorithm: 'Algoritmo',
  healthIntervalMs: 'Intervalo de verificação (ms)',
  intervalMs: 'Intervalo (ms)',
  rulesIn: 'Regras de entrada',
  rulesOut: 'Regras de saída',
  allowedWtps: 'APs permitidos',
  reauthMs: 'Reautenticação (ms)',
  number: 'Número',
  sipPort: 'Porta SIP',
  rtpPort: 'Porta RTP',
  autoAnswer: 'Atender automaticamente',
  paper: 'Papel',
  pagesPerMinute: 'Páginas por minuto',
  id: 'Identificador',
  protocols: 'Protocolos',
  privilege: 'Privilégio',
  datastore: 'Datastore',
  operation: 'Operação',
  target: 'Destino',
  steps: 'Etapas',
  certificate: 'Certificado',
  ca: 'Autoridade certificadora',
  method: 'Método',
  trustedCa: 'CA confiável',
  security: 'Segurança',
  channel: 'Canal',
  band: 'Banda',
  power: 'Potência',
  width: 'Largura',
  privateKey: 'Chave privada',
};
const title = (key: string) => labels[key] ?? key.replace(/([a-z])([A-Z])/g, '$1 $2');
function unwrap(schema?: z.ZodType): z.ZodType | undefined {
  while (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodReadonly
  )
    schema = schema.unwrap() as z.ZodType;
  return schema;
}
function seed(schema?: z.ZodType, key = '', depth = 0): unknown {
  if (depth > 10) return '';
  if (schema instanceof z.ZodDefault) return schema.parse(undefined);
  const s = unwrap(schema);
  if (s instanceof z.ZodObject)
    return Object.fromEntries(
      Object.entries(s.shape)
        .filter(([, v]) => !(v instanceof z.ZodOptional))
        .map(([k, v]) => [k, seed(v as z.ZodType, k, depth + 1)])
    );
  if (s instanceof z.ZodArray) return [];
  if (s instanceof z.ZodUnion) return seed(s.options[0] as z.ZodType, key, depth + 1);
  if (s instanceof z.ZodEnum) return s.options[0];
  if (s instanceof z.ZodLiteral) return [...s.values][0];
  if (s instanceof z.ZodBoolean) return false;
  if (s instanceof z.ZodNumber) return Math.max(s.minValue ?? 0, 0);
  if (/port|underlay|delegatePort/.test(key)) return 'p0';
  if (/password|key/i.test(key)) return 'network-key';
  if (/network|address|target|server|routerId/i.test(key)) return '192.0.2.1';
  return s instanceof z.ZodString && s.minLength ? 'item'.padEnd(s.minLength, '0') : '';
}
function Field({
  value,
  schema,
  path,
  label,
  change,
  choices,
  depth = 0,
}: {
  value: unknown;
  schema?: z.ZodType;
  path: string;
  label: string;
  change: (v: unknown) => void;
  choices: Record<string, Choice[]>;
  depth?: number;
}) {
  let s = unwrap(schema);
  const key = path.split('.').at(-1) ?? path,
    id = useId();
  if (depth > 12) return <p>Estrutura profunda: use o editor avançado.</p>;
  if (s instanceof z.ZodUnion) {
    const options = s.options as z.ZodType[];
    const variant =
      options.find((v) => v.safeParse(value).success) ??
      options.find(
        (v) =>
          v instanceof z.ZodObject &&
          Object.entries(v.shape).some(
            ([k, t]) =>
              t instanceof z.ZodLiteral && t.safeParse((value as Record<string, unknown>)?.[k]).success
          )
      ) ??
      options[0];
    s = unwrap(variant);
    if (options.every((v) => v instanceof z.ZodObject))
      return (
        <fieldset>
          <legend>{label}</legend>
          <label>
            Formato
            <select
              value={options.indexOf(variant as z.ZodObject)}
              onChange={(ev) => change(seed(options[Number(ev.target.value)]))}
            >
              {options.map((v, i) => (
                <option key={i} value={i}>
                  {v instanceof z.ZodObject
                    ? Object.entries(v.shape)
                        .filter(([, t]) => t instanceof z.ZodLiteral)
                        .map(([k, t]) => `${title(k)}: ${[...(t as z.ZodLiteral).values].join('/')}`)
                        .join(', ') || `Formato ${i + 1}`
                    : `Formato ${i + 1}`}
                </option>
              ))}
            </select>
          </label>
          <Field
            value={value}
            schema={variant}
            path={path}
            label="Campos"
            change={change}
            choices={choices}
            depth={depth + 1}
          />
        </fieldset>
      );
  }
  if (Array.isArray(value) || s instanceof z.ZodArray) {
    const list = Array.isArray(value) ? value : [],
      element = s instanceof z.ZodArray ? (s.element as z.ZodType) : undefined;
    return (
      <fieldset>
        <legend>
          {label} ({list.length})
        </legend>
        {list.map((v, i) => (
          <div className="config-item" key={i}>
            <Field
              value={v}
              schema={element}
              path={path + '.' + i}
              label={`${label} ${i + 1}`}
              change={(next) => change(list.map((old, n) => (n === i ? next : old)))}
              choices={choices}
              depth={depth + 1}
            />
            <button
              className="button small"
              type="button"
              onClick={() => change(list.filter((_, n) => n !== i))}
            >
              Remover {label.toLowerCase()} {i + 1}
            </button>
          </div>
        ))}
        <button
          className="button small"
          type="button"
          disabled={list.length >= 1024}
          onClick={() =>
            change([
              ...list,
              element ? seed(element, key) : list[0] !== undefined ? structuredClone(list[0]) : '',
            ])
          }
        >
          Adicionar {label.toLowerCase()}
        </button>
      </fieldset>
    );
  }
  if ((value && typeof value === 'object') || s instanceof z.ZodObject) {
    const object = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>,
      shape = s instanceof z.ZodObject ? s.shape : {};
    const keys = [...new Set([...Object.keys(shape), ...Object.keys(object)])];
    return (
      <fieldset>
        <legend>{label}</legend>
        {keys.map((k) => {
          const child = shape[k] as z.ZodType | undefined,
            optional = child?.safeParse(undefined).success ?? false;
          return (
            <div key={k} className="config-field">
              {!(k in object) && optional ? (
                <button
                  type="button"
                  className="button small"
                  onClick={() => change({ ...object, [k]: seed(child, k) })}
                >
                  Adicionar {title(k).toLowerCase()}
                </button>
              ) : (
                <>
                  <Field
                    value={object[k] ?? seed(child, k)}
                    schema={child}
                    path={path + '.' + k}
                    label={title(k)}
                    change={(next) => change({ ...object, [k]: next })}
                    choices={choices}
                    depth={depth + 1}
                  />
                  {optional && (
                    <button
                      type="button"
                      className="config-remove"
                      aria-label={`Omitir ${title(k).toLowerCase()}`}
                      onClick={() => {
                        const copy = { ...object };
                        delete copy[k];
                        change(copy);
                      }}
                    >
                      Omitir
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}
      </fieldset>
    );
  }
  const pick = choices[key];
  if (pick?.length)
    return (
      <label htmlFor={id}>
        {label}
        <select id={id} value={String(value ?? '')} onChange={(ev) => change(ev.target.value)}>
          {!pick.some((c) => c.value === value) && (
            <option value={String(value ?? '')}>{String(value ?? 'Selecione')}</option>
          )}
          {pick.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
    );
  if (s instanceof z.ZodEnum || s instanceof z.ZodLiteral) {
    const values = s instanceof z.ZodEnum ? s.options : [...s.values];
    return (
      <label htmlFor={id}>
        {label}
        <select
          id={id}
          value={String(value ?? '')}
          onChange={(ev) => change(values.find((v) => String(v) === ev.target.value))}
        >
          {values.map((v) => (
            <option key={String(v)} value={String(v)}>
              {String(v)}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (typeof value === 'boolean' || s instanceof z.ZodBoolean)
    return (
      <label className="config-checkbox" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(ev) => change(ev.target.checked)}
        />
        {label}
      </label>
    );
  if (typeof value === 'number' || s instanceof z.ZodNumber)
    return (
      <label htmlFor={id}>
        {label}
        <input
          id={id}
          type="number"
          step={s instanceof z.ZodNumber && s.format?.includes('int') ? 1 : 'any'}
          min={s instanceof z.ZodNumber ? (s.minValue ?? undefined) : undefined}
          max={s instanceof z.ZodNumber ? (s.maxValue ?? undefined) : undefined}
          value={String(value ?? '')}
          onChange={(ev) => change(ev.target.value === '' ? '' : Number(ev.target.value))}
        />
      </label>
    );
  return (
    <label htmlFor={id}>
      {label}
      <input
        id={id}
        type={/password|privateKey|^key$/i.test(key) ? 'password' : 'text'}
        maxLength={s instanceof z.ZodString ? (s.maxLength ?? undefined) : undefined}
        value={String(value ?? '')}
        onChange={(ev) => change(ev.target.value)}
      />
    </label>
  );
}
export function ConfigEditor({
  label,
  schema,
  value,
  defaultValue = '',
  onChange,
  choices = {},
  ...props
}: Props) {
  const [local, setLocal] = useState(defaultValue),
    [advanced, setAdvanced] = useState(false),
    id = useId(),
    text = value ?? local;
  let parsed: unknown,
    error = '';
  try {
    parsed = JSON.parse(text);
  } catch {
    error = 'JSON inválido. Abra o editor avançado para corrigir.';
  }
  const result = !error && schema?.safeParse(parsed);
  const update = (v: string) => {
    setLocal(v);
    onChange?.({ target: { value: v } });
  };
  return (
    <div className="config-editor">
      {!error && (
        <Field
          value={parsed}
          schema={schema}
          path="config"
          label={label.replace(/\s*\(?JSON\)?$/i, '')}
          change={(v) => update(JSON.stringify(v, null, 2))}
          choices={choices}
        />
      )}
      {error ? (
        <p role="alert">{error}</p>
      ) : result && !result.success ? (
        <p className="config-validation" role="status">
          Revise:{' '}
          {result.error.issues
            .slice(0, 3)
            .map((v) => `${v.path.map(String).join('.')}: ${v.message}`)
            .join(' · ')}
        </p>
      ) : null}
      <details open={advanced || Boolean(error)} onToggle={(ev) => setAdvanced(ev.currentTarget.open)}>
        <summary>Editor avançado JSON · {label}</summary>
        <label htmlFor={id}>
          {label}
          <textarea
            {...props}
            aria-label={props['aria-label'] ?? label}
            id={id}
            name={undefined}
            className="config-json"
            value={text}
            onChange={(ev) => update(ev.target.value)}
          />
        </label>
      </details>
      {props.name && <input type="hidden" name={props.name} value={text} />}
    </div>
  );
}
