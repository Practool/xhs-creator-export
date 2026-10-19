export type ValueStatus = 'available' | 'not_available' | 'not_applicable' | 'collection_failed' | 'unknown';
export interface Metric {
  metric_key: string; value: number | string | boolean | null; value_type: string; unit: string;
  value_status: ValueStatus; source_kind: string; source_field_path: string; metric_schema_version: number;
  metric_scope: 'unknown' | 'lifetime' | 'selected_period'; window_start: string | null; window_end: string | null;
}
export interface NormalizedSnapshot {
  account_scope: string; note_id: string; job_id: string; title: string; note_type: string;
  published_at_utc: string | null; published_time_raw: unknown; observed_at_utc: string | null;
  observed_time_raw: unknown; time_precision: string; timestamp_source: string;
  quality_status: 'valid' | 'warning' | 'needs_review'; warnings: string[]; unmapped_fields: Record<string, unknown>;
  metrics: Metric[]; business_fingerprint: string;
}
export interface Snapshot extends NormalizedSnapshot {
  snapshot_id: string; revision: number; is_current: number; imported_at: string; source_fingerprint: string;
}
export interface Source {
  jobId: string; root: string; fingerprint: string; archive: any; validation: any;
}
export interface Issue { code: string; note_id?: string; action: string }
export interface JobResult {
  job_id: string; result: string; added: number; revised: number; unchanged: number; rejected: number;
  issues: Issue[];
}
export interface SyncReport { started_at: string; finished_at?: string; scanned: number; results: JobResult[]; cancelled: boolean }
