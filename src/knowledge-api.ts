import { invoke } from '@tauri-apps/api/core';
import { attachmentPacket, type ParseStatus } from './api';
import type { PdfTextPage } from './pdf';

export const KNOWLEDGE_FORMATS = ['pdf', 'docx', 'txt', 'md', 'csv'] as const;
export const KNOWLEDGE_ACCEPT = KNOWLEDGE_FORMATS.map((format) => '.' + format).join(',');
export type KnowledgeFormat = typeof KNOWLEDGE_FORMATS[number];
export const INDEX_LABELS: Record<ParseStatus, string> = {
  complete: '索引已完成', partial: '索引部分完成', empty: '未索引 · 无可提取文字', failed: '未索引 · 提取失败',
};

export interface KnowledgeValidity {
  region: string; issuer: string; publishedOn: string; effectiveOn: string; expiresOn: string; sourceUrl: string;
}

export interface KnowledgeEdit extends KnowledgeValidity {
  id: number; name: string; categoryId: number | null; tags: string[]; aiAllowed: boolean;
}

export interface KnowledgeFile extends KnowledgeEdit {
  format: KnowledgeFormat; byteSize: number; uploadedAt: number; updatedAt: number;
  indexVersion: number; revision: number; parseStatus: ParseStatus;
}

export interface KnowledgeChunk { ordinal: number; page: number | null; text: string }
export interface KnowledgeDetail { document: KnowledgeFile; chunks: KnowledgeChunk[] }
export interface KnowledgeCategory { id: number; name: string; count: number }
export interface KnowledgeFilter { query?: string; categoryId?: number; uncategorized?: boolean; tag?: string; aiOnly?: boolean; offset?: number; limit?: number }
export interface KnowledgeTarget { id?: number; page?: number; chunk?: number; query?: string; categoryId?: number }
export interface UploadResult { id: number; duplicate: boolean; cleanupPending: boolean }
export interface RecentKnowledgeFile {
  id: number; name: string; format: KnowledgeFormat; uploadedAt: number; viewedAt: number | null; canAsk: boolean;
}

type Commands = {
  facets: [undefined, { categories: KnowledgeCategory[]; tags: string[] }];
  summary: [undefined, { categories: KnowledgeCategory[]; uploaded: RecentKnowledgeFile[]; viewed: RecentKnowledgeFile[] }];
  list: [{ filter: KnowledgeFilter }, { items: KnowledgeFile[]; total: number }];
  detail: [{ id: number }, KnowledgeDetail];
  save: [{ edit: KnowledgeEdit }, null];
  delete: [{ id: number }, boolean];
  save_category: [{ id?: number; name: string }, number];
  delete_category: [{ id: number }, null];
};

export function knowledge<K extends keyof Commands>(action: K, ...args: Commands[K][0] extends undefined ? [] : [Commands[K][0]]) {
  return invoke<Commands[K][1]>('dispatch', { request: { action: 'knowledge', operation: { action, ...args[0] } } });
}

export const recentKnowledge = () => invoke<KnowledgeFile[]>('dispatch', { request: { action: 'knowledge_recent' } });
export const readKnowledge = (id: number) => invoke<ArrayBuffer | number[]>('read_knowledge', { id });
export const openKnowledge = (id: number) => invoke<void>('open_knowledge', { id });
type SourceLink = { kind: 'knowledge'; id: number } | { kind: 'reference'; messageId: number; ordinal: number };
export const openSourceLink = (source: SourceLink) => invoke<void>('open_source_link', { source });
export function uploadKnowledge(file: Uint8Array, metadata: {
  name: string; categoryId?: number; replaceId?: number; parseStatus?: ParseStatus; pdfPages?: PdfTextPage[];
}) {
  return invoke<UploadResult>('import_knowledge', attachmentPacket(metadata, file));
}
