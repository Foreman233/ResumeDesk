import { Channel, invoke } from '@tauri-apps/api/core';
import type { ConsentCapability } from './api';

export type ChatMode = 'general' | 'workspace';
export type ChatRole = 'assistant' | 'user';
export interface ChatConversation { id: number; mode: ChatMode; title: string; updatedAt: number }
export interface ChatSource {
  ordinal: number;
  label: string;
  candidateId: number | null;
  jobId: number | null;
  resumeId: number | null;
  documentId: number | null;
  page: number | null;
  chunkOrdinal: number | null;
  url: string | null;
  retrievedAt: number | null;
  evidence: string;
}
export interface ChatMessage { id: number; role: ChatRole; text: string; sources: ChatSource[] }
export interface ChatDraft {
  conversation: number; question: string; candidateIds: number[]; jobIds: number[];
  includeHistory: boolean; redact: boolean;
  knowledgeIds?: number[];
  webQuery?: string;
}
export interface ChatPreview {
  id: string; endpoint: string; model: string; timeoutSeconds: number; mode: ChatMode;
  confirmationRequired: boolean; highRisk: boolean; question: string;
  scopes: { capability: ConsentCapability; description: string }[];
  knowledgeRequested: boolean;
  localOnly: boolean;
  search: { endpoint: string; query: string } | null;
  history: { role: ChatRole; text: string }[];
  excerpts: { source: ChatSource; text: string; truncated: boolean; policyMetadata: {
    region: string; issuer: string; publishedOn: string; effectiveOn: string; expiresOn: string; page: number | null;
  } | null }[];
}

type Commands = {
  list: [undefined, ChatConversation[]];
  open: [{ id: number }, ChatMessage[]];
  create: [{ mode: ChatMode }, ChatConversation];
  rename: [{ id: number; title: string }, null];
  delete: [{ id: number }, null];
  clear: [{ id: number }, null];
  preview: [{ draft: ChatDraft }, ChatPreview];
  dismiss: [{ id: string }, null];
};

export function chatRpc<K extends keyof Commands>(action: K, ...args: Commands[K][0] extends undefined ? [] : [Commands[K][0]]) {
  return invoke<Commands[K][1]>('chat_dispatch', { request: { action, ...args[0] } });
}

export function sendChat(id: string, question: string, excerpts: string[], confirmed: boolean, remember: boolean, onDelta: (text: string) => void) {
  const updates = new Channel<string>();
  updates.onmessage = onDelta;
  return invoke<ChatMessage[]>('chat_send', { request: { id, question, excerpts, confirmed, remember }, updates });
}

export const cancelChat = (id: string) => invoke<void>('chat_cancel', { id });
