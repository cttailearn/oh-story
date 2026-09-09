import { useEffect, useState } from 'react';
import { api } from '../api/client.ts';

/**
 * Save-directory picker for the new-novel / new-project wizards. Lets the user type or pick
 * a directory (relative to the workspace) where the new project files will be created,
 * with live suggestions from the server filesystem.
 */

/** Normalize a raw relative-path input into a safe relative dir ('' = workspace root). */
export function normalizeDirInput(raw: string, fallback = ''): string {
  const t0 = (raw ?? '').trim();
  if (/^[A-Za-z]:/.test(t0) || t0.startsWith('/')) return fallback;
  const parts = t0.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.' && s !== '..');
  return parts.join('/');
}

interface DirPickerProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}

export function DirPicker({ value, onChange, placeholder }: DirPickerProps) {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [workspaceAbs, setWorkspaceAbs] = useState('');
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .workspaceDirs()
      .then((r) => { setSuggestions(r.items ?? []); setWorkspaceAbs(r.workspace ?? ''); })
      .catch((e) => setLoadErr(e?.message ?? String(e)));
  }, []);

  const norm = normalizeDirInput(value, '');
  const badPath = value.split('/').some((s) => s === '..') || /^[A-Za-z]:/.test(value.trim()) || value.trim().startsWith('/');
  const targetAbs = workspaceAbs + (norm ? '\\' + norm.split('/').join('\\') : '');

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          list="dir-picker-suggest"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? './'}
          style={{
            flex: 1,
            padding: '6px 8px',
            border: '1px solid var(--line)',
            background: 'var(--paper)',
            color: 'var(--ink)',
            fontFamily: 'var(--font-serif)',
            fontSize: 14,
          }}
        />
        <span className="mono" style={{ fontSize: 11.5, color: 'var(--ink-2)' }}>
          {'\u76f8\u5bf9\u5de5\u4f5c\u533a'}
        </span>
      </div>
      <datalist id="dir-picker-suggest">
        {suggestions.map((d) => (<option key={d} value={d} />))}
      </datalist>
      <div style={{ fontSize: 12, color: 'var(--ink-2)', wordBreak: 'break-all' }}>
        {'\u4fdd\u5b58\u5230\uff1a'}{workspaceAbs ? targetAbs : '...'}{!norm ? ' (' + '\u5de5\u4f5c\u533a\u6839\u76ee\u5f55' + ')' : ''}
      </div>
      {badPath && (
        <div style={{ color: 'var(--red-vermillion)', fontSize: 12 }}>
          {'\u76ee\u5f55\u4e0d\u80fd\u5305\u542b .. / \u7edd\u5bf9\u8def\u5f84'}
        </div>
      )}
      {loadErr && <div style={{ color: 'var(--red-vermillion)', fontSize: 12 }}>{'\u52a0\u8f7d\u76ee\u5f55\u5931\u8d25\uff1a'}{loadErr}</div>}
    </div>
  );
}