export type JobStatus = 'running' | 'waiting_for_user' | 'partial' | 'complete_with_warnings' | 'complete' | 'cancelled';
export type Row = Record<string, string | number | null>;
export interface Config {
  browser: 'auto' | 'chrome' | 'chromium'; profileDir: string; outputDir: string; databasePath: string;
  headless: boolean; dateStrategy: 'platform'; intervalMs: number; operationTimeoutMs: number;
  downloadTimeoutMs: number; stepRetries: number; noteRestarts: number;
}
export interface Note { id: string; url: string; title?: string; artifactName?: string; listText?: string; listData?: Record<string, any> }
export interface Scope { dates: [string, string]; total: number; pages: number; restriction: string }
export interface ResponseRecord {
  endpoint: string; status: number; capturedAt: string; noteId?: string; data: any;
  filters?: { from?: string; to?: string; page?: number; size?: number; type?: string };
}
export interface Artifact {
  path: string; size: number; sha256: string; kind: 'official' | 'screenshot';
  mode?: string; unavailable?: boolean; complete?: boolean; width?: number; height?: number;
  segments?: { from: number; to: number }[];
}
export interface Snapshot {
  url: string; capturedAt: string; identityHint: string; responses: ResponseRecord[];
  diagnoses: { label: string; available: boolean; text: string }[];
  officialFiles: Artifact[]; officialExportError?: string | null;
  coreViewScreenshots: Artifact[]; trendScreenshots: Artifact[];
}
export interface NoteRecord { row: Row; snapshot: Snapshot }
export interface Job {
  schemaVersion: number; id: string; createdAt: string; updatedAt: string; status: JobStatus;
  identityHint?: string; scope?: Scope; requestedDates?: [string, string]; directoryComplete: boolean;
  notes: Note[]; completed: string[]; officialFiles: Artifact[];
  exportWarnings: { noteId: string; message: string }[];
  errors: { noteId: string; message: string }[]; lastError?: string; finishedAt?: string;
  config: Pick<Config, 'browser' | 'intervalMs' | 'operationTimeoutMs' | 'downloadTimeoutMs' | 'stepRetries' | 'noteRestarts'>;
  programVersion: string;
}
export interface Archive { schemaVersion?: number; job: Job; records: NoteRecord[] }
