import { useRef, useState } from 'react';
import { errorText } from './api';
import { uploadKnowledge } from './knowledge-api';

export function useKnowledgeUpload({ refresh, report, onImported }: {
  refresh: () => void;
  report: (message: string, error?: boolean) => void;
  onImported?: (id: number, added: boolean, replaced: boolean) => void;
}) {
  const [uploading, setUploading] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const locked = useRef(false);

  async function run(files: File[], { categoryId, replaceId }: { categoryId?: number; replaceId?: number } = {}) {
    if (!files.length || locked.current) return;
    locked.current = true; setErrors([]);
    const failures = files.length > 60 ? ['每次最多处理 60 份文件。'] : [];
    let added = 0;
    let duplicate = 0;
    let heldOpen = false;
    let first: number | undefined;
    try {
      for (const file of files.slice(0, 60)) {
        setUploading(file.name);
        try {
          if (!file.size || file.size > 25 * 1024 * 1024) throw new Error('请选择不超过 25 MB 的非空文件。');
          const bytes = new Uint8Array(await file.arrayBuffer());
          const pdf = file.name.toLowerCase().endsWith('.pdf') ? await (await import('./pdf')).extractPdf(bytes) : undefined;
          const result = await uploadKnowledge(bytes, {
            name: file.name, categoryId, replaceId, parseStatus: pdf?.status, pdfPages: pdf?.pages,
          });
          if (result.duplicate) {
            duplicate += 1;
            if (replaceId) failures.push('选中的文件已存在于资料库。请选择其他原件。');
            else first ??= result.id;
          } else {
            added += 1; first ??= result.id; heldOpen ||= result.cleanupPending;
          }
        } catch (e) { failures.push(file.name + ' · ' + errorText(e)); }
      }
      if (first !== undefined) onImported?.(first, added > 0, replaceId !== undefined);
      if (added) refresh();
      if (added || duplicate) {
        if (replaceId === undefined) report('已上传 ' + added + ' 份资料' + (duplicate ? '，跳过 ' + duplicate + ' 份重复原件' : ''));
        else if (!added) report('原件已存在');
        else report(heldOpen ? '原件已替换，释放旧文件后将继续清理。' : '原件和索引已更新，请重新设置 AI 引用权限。');
      }
      setErrors(failures);
    } finally {
      setUploading(''); locked.current = false;
    }
  }

  return { uploading, errors, run };
}
