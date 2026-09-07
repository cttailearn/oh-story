import { useState } from 'react';

/** 门禁报告卡（webui-frontend §3.5：blocking/warning 印徽 + 明细展开） */
export function GateReportCard({ result }: { result: any }) {
  const [open, setOpen] = useState(false);
  if (result?.error) {
    return (
      <div className="rail-block" style={{ borderColor: 'var(--red-vermillion)' }}>
        <strong style={{ color: 'var(--red-vermillion)' }}>门禁失败：</strong>
        <span style={{ fontSize: 13 }}>{result.error}</span>
      </div>
    );
  }
  const blocking = result?.blocking ?? false;
  const reports: any[] = result?.reports ?? [];
  return (
    <div
      className="rail-block"
      style={{
        marginTop: 12,
        borderColor: blocking ? 'var(--red-vermillion)' : 'var(--green-jade)',
        borderLeft: `4px solid ${blocking ? 'var(--red-vermillion)' : 'var(--green-jade)'}`,
      }}
    >
      <div className="rb-title">
        门禁报告
        <span className={`seal ${blocking ? 'seal-blocking' : 'seal-pass'}`}>
          {blocking ? '朱批·阻塞' : 'PASS'}
        </span>
      </div>

      {reports.map((r) => (
        <div key={r.gate} style={{ padding: '8px 0', borderBottom: '1px dashed var(--line)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong style={{ fontSize: 13.5 }}>{r.gate}</strong>
            <span className={`seal ${r.blocking?.length ? 'seal-blocking' : r.warnings?.length ? 'seal-pending' : 'seal-pass'}`}>
              {r.blocking?.length ? `${r.blocking.length} 阻塞` : r.warnings?.length ? '有警示' : 'PASS'}
            </span>
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--ink-2)', marginTop: 4 }}>
            {r.ran_ms}ms · {r.value ? JSON.stringify(r.value) : ''}
          </div>
          {r.blocking?.length > 0 && (
            <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12.5, color: 'var(--red-vermillion)' }}>
              {(r.blocking as any[]).slice(0, 5).map((b, i) => (
                <li key={i}>
                  <strong>{b.rule}</strong> —— {b.evidence}
                  {b.file && (
                    <span className="mono" style={{ opacity: 0.7 }}>
                      {' '}
                      ({b.file.split('/').pop()}
                      {b.line ? `:${b.line}` : ''})
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {r.warnings?.length > 0 && (
            <details open={open} style={{ marginTop: 4 }}>
              <summary
                style={{ fontSize: 12, color: 'var(--gold-saffron)', cursor: 'pointer' }}
                onClick={(e) => {
                  e.preventDefault();
                  setOpen(!open);
                }}
              >
                {open ? '收起' : '展开'} {r.warnings.length} 条警示
              </summary>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12, color: 'var(--ink-2)' }}>
                {(r.warnings as any[]).slice(0, 12).map((w, i) => (
                  <li key={i}>
                    <strong>{w.rule}</strong> —— {w.evidence}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}
