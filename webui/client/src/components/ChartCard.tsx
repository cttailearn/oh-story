/** 图表卡（webui-frontend §10.1 契约 {x, series, markers}）：依赖-free SVG 渲染情绪折线 + 节奏条带 */

type Curve = { x: number[]; series: Array<{ name: string; data: number[] }>; markers?: Array<{ chap: number; label: string; flag?: string }> };

export function EmotionLine({ curve, width = 640, height = 160 }: { curve: Curve; width?: number; height?: number }) {
  const xs = curve.x ?? [];
  const data = curve.series?.[0]?.data ?? [];
  if (xs.length < 2) return <div style={{ color: 'var(--ink-2)', fontSize: 12.5 }}>暂无章节数据。</div>;
  const pad = 22;
  const lo = Math.min(-3, ...data, 0);
  const hi = Math.max(3, ...data, 0);
  const px = (i: number) => pad + (i / (xs.length - 1)) * (width - pad * 2);
  const py = (v: number) => height - pad - ((v - lo) / (hi - lo)) * (height - pad * 2);
  const pts = data.map((v, i) => px(i) + ',' + py(v)).join(' ');
  const zeroY = py(0);
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <line x1={pad} y1={zeroY} x2={width - pad} y2={zeroY} stroke="var(--line)" strokeDasharray="4 4" />
      <polyline points={pts} fill="none" stroke="var(--red-vermillion)" strokeWidth={2} />
      {(curve.markers ?? []).map((m, i) => {
        const idx = xs.indexOf(m.chap);
        if (idx < 0) return null;
        return (
          <g key={i}>
            <circle cx={px(idx)} cy={py(data[idx] ?? 0)} r={4} fill="var(--gold-saffron)" />
            <text x={px(idx)} y={py(data[idx] ?? 0) - 8} fontSize={10} fill="var(--gold-saffron)" textAnchor="middle">{m.flag ?? '🚩'} {m.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

export function RhythmStrip({ curve, width = 640 }: { curve: { x: number[]; value: string[] }; width?: number }) {
  const xs = curve.x ?? [];
  const vals = curve.value ?? [];
  if (xs.length === 0) return <div style={{ color: 'var(--ink-2)', fontSize: 12.5 }}>暂无章节数据。</div>;
  const color: Record<string, string> = { fast: '#C63D2F', climax: '#8C2F1E', steady: '#B8860B', slow: '#2F7C6C' };
  const label: Record<string, string> = { fast: '快', climax: '骤', steady: '稳', slow: '缓' };
  const w = (width - xs.length * 2) / xs.length;
  return (
    <div>
      <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 36 }}>
        {xs.map((n, i) => {
          const v = vals[i] ?? 'steady';
          const h = v === 'climax' ? 36 : v === 'fast' ? 28 : v === 'slow' ? 14 : 20;
          return <div key={n} title={'第' + n + '章 · ' + v} style={{ width: w, height: h, background: color[v] ?? '#aaa', borderRadius: 2 }} />;
        })}
      </div>
      <div style={{ marginTop: 4, fontSize: 10.5, color: 'var(--ink-2)' }}>{xs.map((n) => <span key={n} style={{ display: 'inline-block', width: w + 2, textAlign: 'center' }}>{n}</span>)}</div>
      <div style={{ marginTop: 4, fontSize: 10.5, color: 'var(--ink-2)' }}>
        {Object.entries(label).map(([k, t]) => (<span key={k} style={{ marginRight: 10 }}><span style={{ display: 'inline-block', width: 8, height: 8, background: color[k]!, borderRadius: 2, marginRight: 3 }} />{t}</span>))}
      </div>
    </div>
  );
}
