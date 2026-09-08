// 新建小说种子落盘（webui-frontend P2 / api-contract §3.1-3.2）
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface NovelRequirements {
  题材?: string;
  类型?: string;
  目标字数?: string | number;
  平台风格?: string;
  金手指?: string;
  核心卖点?: string;
  一句话Idea?: string;
  keywords?: string[];
}

/** 需求表单 -> 设定/题材定位.md（契约字段；缺项留待 intake 补） */
export function seedNovelRequirements(bookDir: string, req: NovelRequirements, bookName: string): string[] {
  const dir = join(bookDir, '设定');
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const lines: string[] = ['# 题材定位', '> 由新建小说向导（需求录入）生成的种子；intake 阶段会据此补充契约字段。', ''];
  const put = (label: string, value?: string | number | string[]) => {
    if (value === undefined || value === null || value === '') return;
    const v = Array.isArray(value) ? value.join('、') : String(value);
    lines.push('- ' + label + '：' + v);
  };
  put('题材', req.题材);
  put('类型', req.类型);
  put('目标字数', req.目标字数);
  put('平台风格', req.平台风格);
  put('金手指', req.金手指);
  put('核心卖点', req.核心卖点);
  put('一句话Idea', req.一句话Idea);
  put('关键词', req.keywords);
  writeFileSync(join(dir, '题材定位.md'), lines.join('\n') + '\n', 'utf8');
  written.push('设定/题材定位.md');

  const style = join(dir, '文风.md');
  if (!existsSync(style)) {
    writeFileSync(style, '# 文风\n- 平台风格：' + (req.平台风格 ?? '待定') + '\n- 去AI味档位：medium\n', 'utf8');
    written.push('设定/文风.md');
  }
  return written;
}
