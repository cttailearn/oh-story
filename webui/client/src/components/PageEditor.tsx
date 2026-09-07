import { useEffect, useRef } from 'react';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  placeholder as cmPlaceholder,
} from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';

/** CodeMirror 6 书页式编辑器（webui-frontend §3.3 / M0.6），草稿存 localStorage */

interface PageEditorProps {
  value: string;
  onChange?: (value: string) => void;
  draftKey?: string;
  placeholder?: string;
}

export function PageEditor({ value, onChange, draftKey, placeholder }: PageEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const darkTheme = EditorView.theme(
    {
      '&': {
        backgroundColor: 'var(--paper)',
        color: 'var(--ink)',
        height: '100%',
        fontSize: '16px',
      },
      '.cm-content': {
        fontFamily: 'var(--font-serif)',
        lineHeight: '1.9',
        maxWidth: 'var(--max-w)',
        padding: '14px 20px',
      },
      '.cm-line': {
        padding: '0 4px',
      },
      '.cm-gutters': {
        backgroundColor: 'transparent',
        color: 'var(--ink-2)',
        borderRight: 'none',
      },
      '.cm-activeLine': {
        backgroundColor: 'color-mix(in srgb, var(--gold-saffron) 8%, transparent)',
      },
      '.cm-cursor': {
        borderLeftColor: 'var(--red-vermillion)',
      },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
        backgroundColor: 'color-mix(in srgb, var(--gold-saffron) 22%, transparent)',
      },
      '.cm-placeholder': {
        color: 'var(--ink-2)',
        opacity: 0.6,
      },
    },
    { dark: false },
  );

  useEffect(() => {
    if (!hostRef.current) return;

    // 草稿优先
    let initContent = value;
    if (draftKey) {
      const draft = loadDraft(draftKey);
      if (draft != null) initContent = draft;
    }

    const state = EditorState.create({
      doc: initContent,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(defaultHighlightStyle),
        darkTheme,
        placeholder ? cmPlaceholder(placeholder) : [],
        // 变更 → onChange（不写回 value，父组件负责）
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current?.(update.state.doc.toString());
          }
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: hostRef.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  // 外部 value 变化（非草稿模式）→ 同步（避免光标跳走）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (!draftKey) {
      const cur = view.state.doc.toString();
      if (cur !== value) {
        view.dispatch({ changes: { from: 0, to: cur.length, insert: value } });
      }
    }
  }, [value, draftKey]);

  const persistDraft = (v: string) => {
    if (draftKey) saveDraft(draftKey, v);
  };

  return (
    <div ref={hostRef} style={{ height: '100%', width: '100%' }} onBlur={() => {
      if (draftKey && viewRef.current) persistDraft(viewRef.current.state.doc.toString());
    }} />
  );
}

function loadDraft(key: string): string | null {
  try {
    return localStorage.getItem(`draft:${key}`);
  } catch {
    return null;
  }
}
function saveDraft(key: string, value: string) {
  try {
    localStorage.setItem(`draft:${key}`, value);
  } catch {
    /* ignore */
  }
}
