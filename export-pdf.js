#!/usr/bin/env node
/**
 * 白板 PDF 导出工具
 * 用法:
 *   node export-pdf.js                        # 导出所有白板
 *   node export-pdf.js <boardId>              # 导出指定白板
 *   node export-pdf.js --output ./exports     # 指定输出目录
 */

const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

// Windows 系统中文字体候选列表
const SYSTEM_CN_FONTS = [
  'C:\\Windows\\Fonts\\simhei.ttf',   // 黑体
  'C:\\Windows\\Fonts\\simsun.ttc',   // 宋体
  'C:\\Windows\\Fonts\\msyh.ttc',     // 微软雅黑
];

/**
 * 嵌入中文字体（取首个可用的系统字体）
 * @returns {{ font, fontBold }} 普通 / 粗体字体对象（相同字体）
 */
async function embedChineseFont(pdfDoc) {
  pdfDoc.registerFontkit(fontkit);
  for (const fp of SYSTEM_CN_FONTS) {
    if (fs.existsSync(fp)) {
      try {
        const bytes = fs.readFileSync(fp);
        const font = await pdfDoc.embedFont(bytes, { subset: true });
        return { font, fontBold: font };
      } catch (_) { /* 继续尝试下一个 */ }
    }
  }
  // 找不到中文字体时退回标准字体（中文会显示为方框，但不崩溃）
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  return { font, fontBold: await pdfDoc.embedFont(StandardFonts.HelveticaBold) };
}

// ── 参数解析 ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let targetBoardId = null;
let outputDir = path.join(__dirname, 'exports');

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--output' && args[i + 1]) {
    outputDir = path.resolve(args[++i]);
  } else if (!args[i].startsWith('--')) {
    targetBoardId = args[i];
  }
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

/** 格式化时间戳为可读字符串 */
function formatDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
}

/** 读取 index.json，返回 categoryId -> categoryName 映射 */
function loadCategories() {
  const indexPath = path.join(__dirname, 'index.json');
  if (!fs.existsSync(indexPath)) return {};
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  const map = {};
  (index.categories || []).forEach(c => { map[c.id] = c.name; });
  return map;
}

/** 将 base64 data URL 解码为 Buffer，并返回 { bytes, mimeType } */
function decodeDataUrl(dataUrl) {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  return { mimeType: m[1], bytes: Buffer.from(m[2], 'base64') };
}

/** 绘制圆角矩形路径 */
function drawRoundedRect(page, x, y, w, h, r, opts) {
  const { borderColor, fillColor, borderWidth = 1 } = opts;
  page.drawRectangle({ x, y, width: w, height: h, borderRadius: r,
    borderColor, color: fillColor, borderWidth });
}

// ── 核心导出函数 ──────────────────────────────────────────────────────────────

/**
 * 将单个白板 JSON 文件导出为 PDF
 * @param {string} boardPath  boards/*.json 的完整路径
 * @param {object} categories id -> name 映射
 */
async function exportBoard(boardPath, categories) {
  const board = JSON.parse(fs.readFileSync(boardPath, 'utf-8'));

  const title = board.title || '未命名白板';
  const category = categories[board.categoryId] || '';
  const tags = (board.tags || []).join('  ');
  const createdAt = formatDate(board.createdAt);
  const updatedAt = formatDate(board.updatedAt);
  const headerText = board.headerText || '';

  // ── 创建 PDF ────────────────────────────────────────────────────────────────
  const pdfDoc = await PDFDocument.create();

  // A4 横向 (842 × 595 pt)，若内容是竖向则改为竖向
  const pageWidth = 842;
  const pageHeight = 595;
  const page = pdfDoc.addPage([pageWidth, pageHeight]);

  // 嵌入字体（优先使用系统中文字体）
  const { font, fontBold } = await embedChineseFont(pdfDoc);

  // ── 配色方案 ────────────────────────────────────────────────────────────────
  const COLOR_BG       = rgb(0.97, 0.97, 0.98);
  const COLOR_HEADER   = rgb(0.38, 0.40, 0.95);   // indigo
  const COLOR_WHITE    = rgb(1, 1, 1);
  const COLOR_GRAY     = rgb(0.5, 0.5, 0.5);
  const COLOR_DARK     = rgb(0.1, 0.1, 0.1);
  const COLOR_LABEL    = rgb(0.55, 0.55, 0.60);

  // ── 背景 ────────────────────────────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: 0, width: pageWidth, height: pageHeight, color: COLOR_BG });

  // ── 顶部标题栏 ──────────────────────────────────────────────────────────────
  const HEADER_H = 52;
  page.drawRectangle({ x: 0, y: pageHeight - HEADER_H, width: pageWidth, height: HEADER_H, color: COLOR_HEADER });

  // 标题（最多截断至合适长度）
  const titleFontSize = 18;
  const titleY = pageHeight - HEADER_H / 2 - titleFontSize / 2 + 2;
  page.drawText(title, {
    x: 28, y: titleY,
    size: titleFontSize, font: fontBold, color: COLOR_WHITE,
    maxWidth: 460
  });

  // 右侧分类标签
  if (category) {
    const catW = font.widthOfTextAtSize(category, 11) + 16;
    const catX = pageWidth - catW - 20;
    const catY = pageHeight - HEADER_H / 2 - 9;
    drawRoundedRect(page, catX, catY, catW, 18, 4, {
      fillColor: rgb(1, 1, 1, 0.2),
      borderColor: rgb(1, 1, 1, 0.4),
      borderWidth: 1
    });
    page.drawText(category, { x: catX + 8, y: catY + 4, size: 11, font, color: COLOR_WHITE });
  }

  // ── 左侧元数据栏 ────────────────────────────────────────────────────────────
  const SIDEBAR_W = 170;
  const CONTENT_Y_TOP = pageHeight - HEADER_H - 12;
  const CONTENT_H = CONTENT_Y_TOP - 16;

  page.drawRectangle({
    x: 12, y: 16, width: SIDEBAR_W, height: CONTENT_H,
    color: COLOR_WHITE, borderColor: rgb(0.88, 0.88, 0.92), borderWidth: 1,
    borderRadius: 6
  });

  // 元数据条目
  const metaItems = [
    { label: '创建时间', value: createdAt },
    { label: '更新时间', value: updatedAt },
    { label: '分类',     value: category  },
    { label: '标签',     value: tags || '—' },
  ];
  if (headerText) metaItems.push({ label: '题目', value: headerText });

  let metaY = CONTENT_Y_TOP - 14;
  const metaLabelSize = 8;
  const metaValueSize = 10;
  const metaPad = 14;

  page.drawText('白板信息', {
    x: metaPad, y: metaY,
    size: 11, font: fontBold, color: COLOR_HEADER
  });
  metaY -= 6;
  page.drawLine({
    start: { x: metaPad, y: metaY },
    end: { x: SIDEBAR_W - 2, y: metaY },
    thickness: 0.5, color: rgb(0.85, 0.85, 0.90)
  });
  metaY -= 10;

  for (const item of metaItems) {
    if (metaY < 24) break;
    page.drawText(item.label, {
      x: metaPad, y: metaY,
      size: metaLabelSize, font, color: COLOR_LABEL
    });
    metaY -= 13;

    // 长文本换行
    const maxCharsPerLine = 18;
    const lines = splitTextToLines(item.value, maxCharsPerLine);
    for (const line of lines) {
      if (metaY < 24) break;
      page.drawText(line, {
        x: metaPad, y: metaY,
        size: metaValueSize, font, color: COLOR_DARK
      });
      metaY -= 13;
    }
    metaY -= 4;
  }

  // ── 白板内容区域（图片） ─────────────────────────────────────────────────────
  const CANVAS_X = SIDEBAR_W + 24;
  const CANVAS_W = pageWidth - CANVAS_X - 12;
  const CANVAS_Y = 16;
  const CANVAS_H = CONTENT_H;

  // 画布背景
  page.drawRectangle({
    x: CANVAS_X, y: CANVAS_Y, width: CANVAS_W, height: CANVAS_H,
    color: COLOR_WHITE, borderColor: rgb(0.88, 0.88, 0.92), borderWidth: 1,
    borderRadius: 6
  });

  // 嵌入缩略图
  if (board.thumbnail) {
    const decoded = decodeDataUrl(board.thumbnail);
    if (decoded) {
      let img;
      try {
        if (decoded.mimeType === 'image/png') {
          img = await pdfDoc.embedPng(decoded.bytes);
        } else if (decoded.mimeType === 'image/jpeg' || decoded.mimeType === 'image/jpg') {
          img = await pdfDoc.embedJpg(decoded.bytes);
        }
      } catch (e) {
        console.warn(`  警告: 无法嵌入缩略图 (${e.message})`);
      }

      if (img) {
        const { width: iw, height: ih } = img;
        const padding = 12;
        const maxW = CANVAS_W - padding * 2;
        const maxH = CANVAS_H - padding * 2;
        const scale = Math.min(maxW / iw, maxH / ih);
        const drawW = iw * scale;
        const drawH = ih * scale;
        const drawX = CANVAS_X + (CANVAS_W - drawW) / 2;
        const drawY = CANVAS_Y + (CANVAS_H - drawH) / 2;

        page.drawImage(img, { x: drawX, y: drawY, width: drawW, height: drawH });
      }
    }
  } else {
    // 无缩略图时显示提示文字
    page.drawText('（无预览图）', {
      x: CANVAS_X + CANVAS_W / 2 - 30,
      y: CANVAS_Y + CANVAS_H / 2,
      size: 12, font, color: COLOR_GRAY
    });
  }

  // ── 页脚 ────────────────────────────────────────────────────────────────────
  const footerY = 4;
  page.drawText(`ID: ${board.id || ''}`, {
    x: 28, y: footerY + 4,
    size: 7, font, color: COLOR_LABEL
  });
  const exportInfo = `导出时间: ${new Date().toLocaleString('zh-CN')}`;
  const exportInfoW = font.widthOfTextAtSize(exportInfo, 7);
  page.drawText(exportInfo, {
    x: pageWidth - exportInfoW - 12, y: footerY + 4,
    size: 7, font, color: COLOR_LABEL
  });

  // ── 输出文件 ────────────────────────────────────────────────────────────────
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_');
  const outName = `${safeTitle}_${(board.id || 'board').slice(0, 8)}.pdf`;
  const outPath = path.join(outputDir, outName);

  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync(outPath, pdfBytes);
  console.log(`  ✓ 已导出: ${outPath}`);
  return outPath;
}

/** 简单按字符数换行（不支持复杂中文断字，但够用） */
function splitTextToLines(text, maxChars) {
  if (!text) return ['—'];
  const result = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    result.push(remaining.slice(0, maxChars));
    remaining = remaining.slice(maxChars);
  }
  if (remaining) result.push(remaining);
  return result;
}

// ── 主入口 ────────────────────────────────────────────────────────────────────
async function main() {
  const boardsDir = path.join(__dirname, 'boards');
  if (!fs.existsSync(boardsDir)) {
    console.error('错误：找不到 boards/ 目录');
    process.exit(1);
  }

  const categories = loadCategories();
  const files = fs.readdirSync(boardsDir).filter(f => f.endsWith('.json'));

  if (files.length === 0) {
    console.log('boards/ 目录中没有白板文件');
    return;
  }

  const targets = targetBoardId
    ? files.filter(f => f.startsWith(targetBoardId))
    : files;

  if (targets.length === 0) {
    console.error(`错误：未找到 ID 为 "${targetBoardId}" 的白板`);
    process.exit(1);
  }

  console.log(`正在导出 ${targets.length} 个白板到 ${outputDir} ...\n`);

  const results = [];
  for (const file of targets) {
    const boardPath = path.join(boardsDir, file);
    console.log(`处理: ${file}`);
    try {
      const out = await exportBoard(boardPath, categories);
      results.push({ file, out, ok: true });
    } catch (err) {
      console.error(`  ✗ 失败: ${err.message}`);
      results.push({ file, ok: false, err: err.message });
    }
  }

  console.log('\n─────────────────────────────────');
  console.log(`完成: ${results.filter(r => r.ok).length}/${results.length} 个成功`);
}

main().catch(err => { console.error(err); process.exit(1); });
