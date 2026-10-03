/** Versão atual do formato dos eventos/snapshots gravados na pasta. */
export const SCHEMA_VERSION = 1;

export type EventType = 'create' | 'update' | 'archive' | 'restore' | 'resolve';
export const EVENT_TYPES: readonly EventType[] = ['create', 'update', 'archive', 'restore', 'resolve'];

/** Todos os valores de campo são texto ('' = vazio). `null` só aparece em `from` de um create. */
export type FieldValue = string | null;

export interface Change {
  from: FieldValue;
  to: FieldValue;
}

export interface RgEvent {
  schemaVersion: number;
  id: string;
  /** Data/hora física de criação, ISO 8601 UTC. Só informativo — a ordenação usa `hlc`. */
  ts: string;
  /** Hybrid logical clock: "<ms 15 dígitos>-<contador 6 dígitos>", comparável como texto. */
  hlc: string;
  author: string;
  deviceId: string;
  recordId: string;
  type: EventType;
  changes: Record<string, Change>;
  /** Último hlc visto para este registo quando a alteração foi feita (null num create). */
  baseRev: string | null;
}

export const FIELDS = [
  'Nome',
  'NumeroSNS',
  'DataNascimento',
  'Email',
  'Telefone',
  'UnidadeFuncional',
  'MedicoAssistente',
  'DUM',
  'DPP',
  'ProvenienciaContacto',
  'Contactada',
  'DataContacto',
  'Observacoes',
  'Estado',
  'AvisosImportacao',
] as const;
export type FieldName = (typeof FIELDS)[number];

export const FIELD_LABELS: Record<FieldName, string> = {
  Nome: 'Nome',
  NumeroSNS: 'N.º SNS',
  DataNascimento: 'Data de nascimento',
  Email: 'Email',
  Telefone: 'Telefone',
  UnidadeFuncional: 'Unidade funcional',
  MedicoAssistente: 'Médico assistente',
  DUM: 'DUM',
  DPP: 'DPP',
  ProvenienciaContacto: 'Proveniência do contacto',
  Contactada: 'Contactada',
  DataContacto: 'Data do contacto',
  Observacoes: 'Observações',
  Estado: 'Estado',
  AvisosImportacao: 'Avisos da importação',
};

export const DATE_FIELDS: ReadonlySet<string> = new Set(['DataNascimento', 'DUM', 'DPP', 'DataContacto']);

export const ESTADOS = ['Ativa', 'Concluída', 'Desistiu', 'Arquivada'] as const;
export type Estado = (typeof ESTADOS)[number];

export const CONTACTADA_VALUES = ['Sim', 'Não'] as const;

export type RecordValues = Partial<Record<FieldName, string>> & Record<string, string | undefined>;

export interface AppConfig {
  UnidadeFuncional: string[];
  ProvenienciaContacto: string[];
}

export const DEFAULT_CONFIG: AppConfig = {
  UnidadeFuncional: [
    'UCSP Loures',
    'UCSP Tojal',
    'UCSP Bucelas',
    'UCSP Lousa',
    'USF Magnolia',
    'USF Ars médica',
    'USF Parque Cidade',
    'ESMC',
    'UCC Loures',
  ],
  ProvenienciaContacto: ['Plataforma', 'Email', 'Telefone', 'Unidade de Saúde'],
};
