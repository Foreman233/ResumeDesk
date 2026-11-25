import { invoke } from '@tauri-apps/api/core';

export const CATEGORIES = {
  background: '基础背景与求职动机', experience: '工作经历核实', technical: '专业技能与知识', project: '项目经历深挖',
  scenario: '情景模拟与问题解决', star: '行为面试（STAR）', collaboration: '团队协作与沟通能力',
} as const;
export const LEVELS = { basic: '基础', medium: '中等', advanced: '高级' } as const;
export const DIFFICULTIES = { ...LEVELS, mixed: '混合难度' } as const;
export const LANGUAGES = { zh: '中文', en: '英文', bilingual: '中英双语' } as const;
export const SOURCES = { resume: '候选人简历', jd: '岗位 JD', focus: 'HR 自定义要求', general: '通用岗位能力' } as const;
export const MAX_QUESTIONS = 50;

export type Category = keyof typeof CATEGORIES;
export type Level = keyof typeof LEVELS;
export type Difficulty = keyof typeof DIFFICULTIES;
export type Language = keyof typeof LANGUAGES;
export type SourceKind = keyof typeof SOURCES;
export type Allocation = { category: Category; count: number };

export interface InterviewConfig {
  total: number; allocations: Allocation[]; difficulty: Difficulty; language: Language;
  minutes: number | null; focus: string; followUp: boolean; evaluationPoints: boolean; referenceAnswer: boolean;
}
export interface InterviewSelection {
  candidateId: number | null; resumeId: number | null; jobId: number | null; applicationId: number | null;
  jobTitle: string; temporaryJd: string;
}
export interface InterviewQuestion {
  category: Category; difficulty: Level; question: string; competency: string; source: { kind: SourceKind; evidence: string };
  followUp: string; evaluationPoints: string; referenceAnswer: string; interviewerNotes: string; answerSummary: string; verification: string;
}
export interface GuideInput {
  title: string; selection: InterviewSelection; interviewDate: string; config: InterviewConfig; questions: InterviewQuestion[];
}
export interface InterviewGuide { id: number; revision: number; createdAt: number; updatedAt: number; input: GuideInput }
export interface InterviewSummary {
  id: number; title: string; candidateId: number | null; candidateName: string | null; jobId: number | null; jobTitle: string;
  questionCount: number; createdAt: number; updatedAt: number;
}
export interface InterviewTarget {
  guideId?: number; candidateId?: number; resumeId?: number; jobId?: number; applicationId?: number; fresh?: boolean;
}
export interface InterviewPreview {
  id: string; endpoint: string; model: string; confirmationRequired: boolean; highRisk: boolean;
  context: { role: string; resume: string; jd: string; focus: string; truncated: boolean };
}
export interface GeneratedInterview { requested: number; questions: InterviewQuestion[]; adjusted: boolean }

type Commands = {
  list: [{ candidateId?: number; jobId?: number; query?: string; offset?: number; limit?: number }, InterviewSummary[]];
  get: [{ id: number }, InterviewGuide];
  save: [{ id?: number; revision?: number; input: GuideInput }, InterviewGuide];
  delete: [{ id: number; revision: number }, null];
};

export function interview<K extends keyof Commands>(action: K, options: Commands[K][0]) {
  return invoke<Commands[K][1]>('dispatch', { request: { action: 'interview', operation: { action, ...options } } });
}
export const prepareInterview = (selection: InterviewSelection, config: InterviewConfig) =>
  invoke<InterviewPreview>('dispatch', { request: { action: 'prepare_interview', selection, config } });
export const dismissInterview = (id: string) => invoke<void>('dispatch', { request: { action: 'dismiss_interview', id } });
export const generateInterview = (id: string, confirmed: boolean, remember: boolean) =>
  invoke<GeneratedInterview>('generate_interview', { request: { id, confirmed, remember } });

export function distribute(total: number, categories: Category[]): Allocation[] {
  if (!categories.length) return [];
  const each = Math.floor(total / categories.length);
  const extras = total % categories.length;
  return categories.map((category, index) => ({ category, count: each + Number(index < extras) }));
}

export const defaultConfig = (): InterviewConfig => ({
  total: 10, allocations: distribute(10, ['experience', 'technical', 'project', 'star']),
  difficulty: 'mixed', language: 'zh', minutes: 45, focus: '', followUp: true, evaluationPoints: true, referenceAnswer: false,
});

export const blankQuestion = (category: Category = 'background'): InterviewQuestion => ({
  category, difficulty: 'medium', question: '', competency: '', source: { kind: 'general', evidence: '' },
  followUp: '', evaluationPoints: '', referenceAnswer: '', interviewerNotes: '', answerSummary: '', verification: '',
});
