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

/** CodeMirror 6 page-like editor (webui-frontend v3.3 / M0.6), draft stored in localStorage */

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

  // Whether a local draft exists for the current file. When it does, the draft is the
  // source of truth and external value changes must NOT overwrite it. When no draft
  // exists, the editor must keep following external value (server-loaded content),
  // which fixes the bug where switching chapters keeps showing the previous chapter
  // and first-open stays blank (the lazy chunk / post-switch fetch complete late).
  const draftExistRef = useRef(false);

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

  // Create the editor. Re-runs whenever draftKey changes (a different file is opened),
  // rebuilding the CM instance with the right initial content.
  useEffect(() => {
    if (!hostRef.current) return;

    // Draft wins when present; otherwise start from the current value (server content if loaded).
    const draft = draftKey ? loadDraft(draftKey) : null;
    const initContent = draft != null ? draft : value;
    draftExistRef.current = draft != null;

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
        // change -> onChange (the parent owns the value; we never write it back ourselves)
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

  // Sync external value changes into the editor (keeps the caret from jumping).
  // When a draft exists the draft is the source of truth, so do not overwrite it;
  // user keystrokes already flow back through onChange so there is nothing to re-apply.
  // When no draft exists (including the post-switch server fetch resolving), replace the
  // doc with the newest value -- this fixes stale/blank content across file switches.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (draftExistRef.current) return;
    const cur = view.state.doc.toString();
    if (cur !== value) {
      view.dispatch({ changes: { from: 0, to: cur.length, insert: value } });
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
    return localStorage.getItem('draft:' + key);
  } catch {
    return null;
  }
}
function saveDraft(key: string, value: string) {
  try {
    localStorage.setItem('draft:' + key, value);
  } catch {
    /* ignore */
  }
}