// 零依赖 EPUB3 写入器（基于 writeZip；mimetype stored 首条目，OPF/spine/toc.ncx/nav）
// 用于 epub 导出（M4 export-publish §1：阅读器成品，内嵌封面/分卷/目录）
import { writeZip } from './zip.ts';

export interface EpubChapter {
  id: string; // 如 ch001
  title: string;
  html: string; // <h1>..</h1><p>...</p>（body 片段）
}

export interface EpubOptions {
  title: string;
  creator?: string;
  language?: string;
  uuid?: string;
  chapters: EpubChapter[];
  cover?: Buffer | null; // 封面图（jpg/png）
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CSS = `body { font-family: serif; line-height: 1.7; margin: 5% 8%; font-size: 1em; }
h1 { font-size: 1.4em; text-align: center; margin: 1.2em 0 .8em; }
p { text-indent: 2em; margin: .6em 0; }
h2 { font-size: 1.2em; margin-top: 1em; }`;

/** 生成 .epub Buffer（EPUB3 + toc.ncx 兼容） */
export function writeEpub(opts: EpubOptions): Buffer {
  const uuid = opts.uuid ?? 'urn:uuid:' + crypto.randomUUID ? crypto.randomUUID() : ('ohrepo-' + Date.now().toString(16));
  const lang = opts.language ?? 'zh-CN';
  const coverExt = opts.cover ? sniffImageExt(opts.cover) : null;
  const entries: Array<{ name: string; data: Buffer | string; stored?: boolean }> = [];

  // 1) mimetype 必须是首个、store 不压缩
  entries.push({ name: 'mimetype', data: Buffer.from('application/epub+zip', 'utf8'), stored: true });

  // 2) container
  entries.push({ name: 'META-INF/container.xml', data: `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>` });

  // 3) content.opf
  const items: string[] = [];
  const spine: string[] = [];
  if (coverExt) {
    items.push(`<item id="cover" href="cover.${coverExt}" media-type="image/${coverExt}"/>`);
    items.push(`<item id="coverpage" href="coverpage.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push('<itemref idref="coverpage"/>');
  }
  items.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
  items.push('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');
  items.push('<item id="css" href="style.css" media-type="text/css"/>');
  opts.chapters.forEach((c) => {
    items.push(`<item id="${c.id}" href="${c.id}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="${c.id}"/>`);
  });

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="${lang}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${uuid}</dc:identifier>
    <dc:title>${esc(opts.title)}</dc:title>
    ${opts.creator ? `<dc:creator>${esc(opts.creator)}</dc:creator>` : ''}
    <dc:language>${lang}</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
  </metadata>
  <manifest><item id="opf" href="content.opf" media-type="application/oebps-package+xml" required-namespace="http://www.idpf.org/2007/opf"/> ${items.join(' ')}</manifest>
  <spine toc="ncx">${spine.join(' ')}</spine>
</package>`;
  entries.push({ name: 'OEBPS/content.opf', data: opf });

  // 4) nav.xhtml（EPUB3 目录）
  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}">
<head><title>${esc(opts.title)}</title><link rel="stylesheet" href="style.css"/></head>
<body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops">
<h1>目录</h1><ol>
${opts.chapters.map((c) => `<li><a href="${c.id}.xhtml">${esc(c.title)}</a></li>`).join('\n')}
</ol></nav></body></html>`;
  entries.push({ name: 'OEBPS/nav.xhtml', data: nav });

  // 5) toc.ncx（兼容旧阅读器）
  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="${uuid}"/><meta name="dtb:depth" content="1"/></head>
  <docTitle><text>${esc(opts.title)}</text></docTitle>
  <navMap>
    ${opts.chapters.map((c, i) => `<navPoint id="np${i + 1}" playOrder="${i + 1}"><navLabel><text>${esc(c.title)}</text></navLabel><content src="${c.id}.xhtml"/></navPoint>`).join('\n')}
  </navMap>
</ncx>`;
  entries.push({ name: 'OEBPS/toc.ncx', data: ncx });

  entries.push({ name: 'OEBPS/style.css', data: CSS });

  if (coverExt) {
    entries.push({ name: `OEBPS/cover.${coverExt}`, data: opts.cover! });
    entries.push({
      name: 'OEBPS/coverpage.xhtml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${esc(opts.title)}</title></head>
<body><img src="cover.${coverExt}" alt="封面" style="max-width:100%;"/></body></html>`,
    });
  }

  // 6) 章节
  opts.chapters.forEach((c) => {
    entries.push({
      name: `OEBPS/${c.id}.xhtml`,
      data: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}">
<head><title>${esc(c.title)}</title><link rel="stylesheet" href="style.css"/></head>
<body>${c.html}</body></html>`,
    });
  });

  return writeZip(entries);
}

function sniffImageExt(buf: Buffer): 'jpg' | 'png' {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  return 'jpg';
}
