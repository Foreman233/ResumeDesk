import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import type { Stage } from './api';

export const TODO_CATEGORIES = {
  general: '通用', screening: '简历筛选', interview: '面试', follow_up: '跟进',
} as const;
export const TODO_PRIORITY = { low: '低', normal: '普通', high: '高' } as const;
export const TODO_STATUS = { pending: '待完成', completed: '已完成', cancelled: '已取消' } as const;
export type TodoCategory = keyof typeof TODO_CATEGORIES;
export type TodoPriority = keyof typeof TODO_PRIORITY;
export type TodoStatus = keyof typeof TODO_STATUS;
export type MeetingMode = 'online' | 'onsite';
export type TodoLink = { candidateId?: number | null; jobId?: number | null; applicationId?: number | null; stage?: Stage | null };
export type TodoInput = TodoLink & {
  id?: number; title: string; description?: string; priority: TodoPriority; category: TodoCategory;
  dueAt?: number | null; interviewAt?: number | null; reminderMinutes?: number | null;
  meetingMode?: MeetingMode | null; meetingLink?: string; location?: string; notes?: string;
};
export type Todo = TodoInput & {
  id: number; status: TodoStatus; createdAt: number; updatedAt: number; completedAt?: number | null;
  remindAt?: number | null; notifiedAt?: number | null; reminderError?: string | null;
  candidateName?: string | null; jobTitle?: string | null;
};
type TodoFilter = { status?: TodoStatus; category?: TodoCategory; candidateId?: number; jobId?: number; applicationId?: number; query?: string };
export type TodoRule = { stage: Stage; enabled: boolean };
export type TodoNavigation = TodoLink & { widget?: boolean };
export type TodoSummaryGroup = 'today' | 'upcoming' | 'overdue';
export type TodoSummaryItem = { id: number; title: string; scheduledAt: number; group: TodoSummaryGroup };
export type TodoTarget = { id?: number; category?: TodoCategory };

const TODO_CHANGED = 'todos-changed';
export const todoChanged = () => { void emit(TODO_CHANGED).catch(() => {}); };
export const watchTodoChanges = (reload: () => void) => listen(TODO_CHANGED, reload);

type TodoCommands = {
  summary: [{ dayEnd: number }, TodoSummaryItem[]];
  get: [{ id: number }, Todo];
  list: [{ filter?: TodoFilter }, Todo[]];
  save: [{ input: TodoInput }, Todo];
  set_status: [{ id: number; status: TodoStatus }, Todo];
  delete: [{ id: number }, null];
  rules: [Record<string, never>, TodoRule[]];
  save_rule: [TodoRule, TodoRule];
};

export function todo<K extends keyof TodoCommands>(action: K, input: TodoCommands[K][0]) {
  return invoke<TodoCommands[K][1]>('dispatch', { request: { action: 'todo', operation: { action, ...input } } });
}
export const showTodoWindow = (visible = true) => invoke<void>('show_todo_window', { visible });
export const setTodoOnTop = (alwaysOnTop: boolean) => invoke<void>('set_todo_on_top', { alwaysOnTop });
export const minimizeTodoWindow = () => invoke<void>('minimize_todo_window');
export const navigateMain = (target: TodoNavigation = {}) => invoke<void>('navigate_main', target);

export const TODO_SUGGESTIONS: Partial<Record<Stage, { title: string; category: TodoCategory }>> = {
  screened: { title: '邀约面试', category: 'follow_up' },
  interview: { title: '安排面试', category: 'interview' },
  interviewed: { title: '收集面试反馈', category: 'follow_up' },
};
