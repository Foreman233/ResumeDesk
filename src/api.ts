import { invoke, isTauri } from '@tauri-apps/api/core';

export const STAGES = {
  new: '待初筛', screened: '初筛通过', interview: '待面试', interviewed: '面试完成',
  hired: '已录用', rejected: '未通过', withdrawn: '已退出',
} as const;
export type Stage = keyof typeof STAGES;
export const JOB_STATUS = { open: '招聘中', paused: '已暂停', closed: '已关闭' } as const;
export type JobStatus = keyof typeof JOB_STATUS;
export type ParseStatus = 'complete' | 'partial' | 'empty' | 'failed';
export const PARSE_LABELS: Record<ParseStatus, string> = {
  complete: '已提取文字', partial: '部分文字已提取', empty: '未识别到文字', failed: '文字提取失败',
};

export interface CandidateInput {
  id?: number; name: string; headline: string; email: string; phone: string; favorite: boolean; tags: string[];
}
export interface Candidate extends CandidateInput {
  id: number; createdAt: number; updatedAt: number; resumeCount: number;
}
export interface Note { id: number; body: string; createdAt: number }
export interface CandidateDetail extends Candidate {
  resumes: ResumeDocument[]; applications: Application[]; notes: Note[];
}
export interface Filter {
  query?: string; jobId?: number; tag?: string; stage?: Stage;
  favorite?: boolean; stale?: boolean; offset?: number;
}
export type ApplicationState = Pick<Application, 'id' | 'jobId' | 'jobTitle' | 'stage'>;
export interface CandidatePage { items: (Candidate & { applications: ApplicationState[] })[]; total: number }
export interface JobInput { id?: number; title: string; department: string; jd: string; status: JobStatus }
export interface Job extends JobInput { id: number; updatedAt: number; applicationCount: number }
export interface Application {
  id: number; candidateId: number; candidateName: string; jobId: number; jobTitle: string;
  stage: Stage; note: string; updatedAt: number;
}
export interface ResumeDocument {
  id: number; ownerId: number; ownerName: string; originalName: string; format: 'pdf' | 'docx';
  byteSize: number; importedAt: number; parseStatus: ParseStatus;
}
export interface Dashboard {
  candidates: number; openJobs: number; screening: number; stale: number; recent: ResumeDocument[];
  progress: { stage: Stage; count: number }[]; viewed: { id: number; name: string; headline: string; viewedAt: number }[];
}
export type WidgetWidth = 1 | 2 | 4;
export type WidgetHeight = 1 | 2 | 3;
export type LayoutSurface = 'dashboard' | 'tools';
export interface DashboardWidget { id: string; width: WidgetWidth; height: WidgetHeight; visible: boolean }
export interface DashboardLayout { version: number; widgets: DashboardWidget[] }
export type ResumeRef = { kind: 'resume'; id: number };
export type ImportTarget = { kind: 'new' } | { kind: 'candidate'; id: number };
type ImportOwner = { documentId: number; ownerId: number; ownerName: string };
export type ImportResult = ImportOwner &
  ({ state: 'imported'; parseStatus: ParseStatus; candidates?: ImportOwner[] } | { state: 'duplicate' });
export interface ImportCandidate {
  section?: number; name: string; headline: string; email: string; phone: string;
}
export interface CandidateImportOptions {
  jobId?: number; autoParse: boolean; candidates?: ImportCandidate[];
}
export interface ImportPreview {
  parseStatus: ParseStatus; candidates: ImportCandidate[];
}
export interface AISettings { baseUrl: string; model: string; timeoutSeconds: number }
export interface AIStatus { settings: AISettings; hasKey: boolean; verified: boolean; credentialError: boolean }
export interface Privacy { retentionDays: number; redactByDefault: boolean }
export interface Settings { ai: AIStatus; privacy: Privacy; dataPath: string }
export interface BackupSummary { attachments: number; cleanupPending: boolean }
export const AI_SCOPES = {
  general: '普通 AI 对话', recruiting: '候选人与岗位资料', knowledge: '本地资料库', web: '联网搜索',
} as const;
export type ConsentCapability = keyof typeof AI_SCOPES;
export interface ConsentPreferences {
  modelProvider: string | null; searchProvider: string | null;
  remembered: { provider: string; capability: ConsentCapability; scopeKey: string; description: string; grantedAt: number }[];
}
export interface WebSearchSettings {
  endpoint: string | null; timeoutSeconds: number; hasKey: boolean; credentialError: boolean; defaultEndpoint: string;
}

type Commands = {
  dashboard: [undefined, Dashboard]; candidate_list: [{ filter: Filter }, CandidatePage]; candidate: [{ id: number }, CandidateDetail];
  dashboard_layout: [{ surface: LayoutSurface }, DashboardLayout | null];
  save_dashboard_layout: [{ layout: DashboardLayout; surface: LayoutSurface }, null];
  record_candidate_view: [{ id: number }, null];
  save_candidate: [{ input: CandidateInput }, number]; favorite: [{ id: number; favorite: boolean }, null];
  delete_candidate: [{ id: number }, boolean]; tags: [undefined, string[]]; add_note: [{ candidateId: number; body: string }, null];
  delete_note: [{ candidateId: number; id: number }, null];
  jobs: [undefined, Job[]]; save_job: [{ input: JobInput }, number]; delete_job: [{ id: number }, boolean];
  applications: [{ jobId: number }, Application[]]; link_application: [{ candidateId: number; jobId: number }, number];
  save_application: [{ id: number; stage: Stage; note: string }, null]; unlink_application: [{ id: number }, null];
  set_application_stage: [{ id: number; stage: Stage }, null];
  document_text: [{ reference: ResumeRef }, string]; delete_document: [{ reference: ResumeRef }, boolean];
  settings: [undefined, Settings]; ai_status: [undefined, AIStatus]; save_privacy: [{ privacy: Privacy }, null];
  save_ai: [{ input: { settings: AISettings; apiKey?: string; removeKey?: boolean } }, AIStatus];
  ai_consents: [undefined, ConsentPreferences]; reset_ai_consents: [{ capability?: ConsentCapability }, ConsentPreferences];
  web_search_settings: [undefined, WebSearchSettings];
  save_web_search: [{ input: { endpoint: string; timeoutSeconds: number; apiKey?: string; removeKey?: boolean } }, WebSearchSettings];
};

export function rpc<K extends keyof Commands>(action: K, ...args: Commands[K][0] extends undefined ? [] : [Commands[K][0]]) {
  if (!isTauri()) return Promise.reject(new Error('请从 ResumeDesk Windows 桌面程序打开工作区。'));
  return invoke<Commands[K][1]>('dispatch', { request: { action, ...args[0] } });
}

export function attachmentPacket(metadata: object, file: Uint8Array) {
  const meta = new TextEncoder().encode(JSON.stringify(metadata));
  const packet = new Uint8Array(4 + meta.length + file.length);
  new DataView(packet.buffer).setUint32(0, meta.length, true);
  packet.set(meta, 4);
  packet.set(file, 4 + meta.length);
  return packet;
}
export const previewImportBytes = (name: string, text: string, status: ParseStatus, file: Uint8Array) =>
  invoke<ImportPreview>('preview_import_document', attachmentPacket({ name, target: { kind: 'new' }, text, status }, file));
export const importBytes = (name: string, target: ImportTarget, text: string, status: ParseStatus, file: Uint8Array, options?: CandidateImportOptions) =>
  invoke<ImportResult>('import_document', attachmentPacket({ name, target, text, status, candidateOptions: options }, file));
export const readOriginal = (reference: ResumeRef) => invoke<ArrayBuffer | number[]>('read_document', { reference });
export const openOriginal = (reference: ResumeRef) => invoke<void>('open_document', { reference });
export const manageBackup = (restore: boolean, passphrase: string, confirmed: boolean) =>
  invoke<BackupSummary | null>('manage_backup', { restore, passphrase, confirmed });
export const testAI = (id: string) => invoke<AIStatus>('test_ai', { id });
export const cancelAI = (id: string) => invoke<void>('cancel_ai', { id });
export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
