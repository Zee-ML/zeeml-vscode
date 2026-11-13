const vscode = require('vscode');

function flattenObject(obj, prefix = '', res = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      flattenObject(v, key, res);
    } else if (Array.isArray(v)) {
      res[key] = JSON.stringify(v);
    } else {
      res[key] = v === undefined || v === null ? '' : String(v);
    }
  }
  return res;
}

function sanitizeFormulaCell(val) {
  const s = String(val ?? '');
  if (/^[=+\-@\t\r]/.test(s) && !/^-[0-9]+(\.[0-9]+)?$/.test(s)) {
    return "'" + s;
  }
  return s;
}

function escapeCsvCell(val) {
  const s = sanitizeFormulaCell(val);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function jsonToCsv(rawText) {
  const parsed = JSON.parse(rawText);
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const flatRows = arr.map(r => flattenObject(r));
  const headers = Array.from(new Set(flatRows.flatMap(r => Object.keys(r))));
  const lines = [headers.map(escapeCsvCell).join(',')];
  for (const row of flatRows) {
    lines.push(headers.map(h => escapeCsvCell(row[h] ?? '')).join(','));
  }
  return lines.join('\n');
}

function parseRfc4180Line(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function csvToJson(rawCsv) {
  const lines = String(rawCsv || '').trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return '[]';
  const headers = parseRfc4180Line(lines[0]);
  const rows = lines.slice(1).map(l => {
    const vals = parseRfc4180Line(l);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] ?? ''; });
    return obj;
  });
  return JSON.stringify(rows, null, 2);
}

function jsonToMarkdown(rawText) {
  const parsed = JSON.parse(rawText);
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const flatRows = arr.map(r => flattenObject(r));
  const headers = Array.from(new Set(flatRows.flatMap(r => Object.keys(r))));
  const headerLine = '| ' + headers.join(' | ') + ' |';
  const sepLine = '| ' + headers.map(() => '---').join(' | ') + ' |';
  const bodyLines = flatRows.map(r => '| ' + headers.map(h => String(r[h] ?? '').replace(/\|/g, '\\|')).join(' | ') + ' |');
  return [headerLine, sepLine, ...bodyLines].join('\n');
}

function computeCadence(text) {
  const clean = String(text || '').trim();
  const words = clean.match(/[A-Za-z0-9']+/g) || [];
  const sentences = clean.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  const lengths = sentences.map(s => (s.match(/[A-Za-z0-9']+/g) || []).length).filter(n => n > 0);
  const mean = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
  const variance = lengths.length ? lengths.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / lengths.length : 0;
  const sd = Math.sqrt(variance);
  const cv = sd / Math.max(1, mean);
  return { words: words.length, sentences: lengths.length, sd, cv };
}

function activate(context) {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'zeeml.inspectCadence';
  context.subscriptions.push(statusBar);

  function refreshStatus() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      statusBar.hide();
      return;
    }
    const sel = editor.selection;
    const text = editor.document.getText(sel.isEmpty ? undefined : sel);
    const m = computeCadence(text);
    statusBar.text = `$(pulse) ZeeML: ${m.words}w | CV ${m.cv.toFixed(2)}`;
    statusBar.tooltip = `ZeeML Cadence Telemetry (${m.sentences} sentences, SD ${m.sd.toFixed(2)}w) - Click for full report or visit https://zeeml.com/word-counter`;
    statusBar.show();
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(refreshStatus),
    vscode.window.onDidChangeTextEditorSelection(refreshStatus),
    vscode.workspace.onDidChangeTextDocument(refreshStatus)
  );
  refreshStatus();

  const cmdCsv = vscode.commands.registerCommand('zeeml.jsonToCsv', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const sel = editor.selection;
    const text = editor.document.getText(sel.isEmpty ? undefined : sel);
    try {
      const csv = jsonToCsv(text);
      const doc = await vscode.workspace.openTextDocument({ content: csv, language: 'csv' });
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (err) {
      vscode.window.showErrorMessage('ZeeML JSON-to-CSV Error: ' + err.message + ' (Web tool: https://zeeml.com/json-to-csv)');
    }
  });

  const cmdCsvToJson = vscode.commands.registerCommand('zeeml.csvToJson', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const sel = editor.selection;
    const text = editor.document.getText(sel.isEmpty ? undefined : sel);
    try {
      const jsonStr = csvToJson(text);
      const doc = await vscode.workspace.openTextDocument({ content: jsonStr, language: 'json' });
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (err) {
      vscode.window.showErrorMessage('ZeeML CSV-to-JSON Error: ' + err.message);
    }
  });

  const cmdMd = vscode.commands.registerCommand('zeeml.jsonToMarkdownTable', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const sel = editor.selection;
    const text = editor.document.getText(sel.isEmpty ? undefined : sel);
    try {
      const md = jsonToMarkdown(text);
      const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (err) {
      vscode.window.showErrorMessage('ZeeML Markdown Table Error: ' + err.message);
    }
  });

  const cmdCadence = vscode.commands.registerCommand('zeeml.inspectCadence', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const sel = editor.selection;
    const text = editor.document.getText(sel.isEmpty ? undefined : sel);
    const m = computeCadence(text);
    const band = m.cv >= 0.42 ? 'High Burstiness' : (m.cv >= 0.24 ? 'Moderate' : 'Uniform / Flat');
    vscode.window.showInformationMessage(
      `ZeeML Telemetry: ${m.words} words | ${m.sentences} sentences | SD: ${m.sd.toFixed(2)}w | CV: ${m.cv.toFixed(2)} (${band}) | https://zeeml.com/ai-humanizer`
    );
  });

  const cmdCgpa = vscode.commands.registerCommand('zeeml.cgpaQuickCalc', async () => {
    const raw = await vscode.window.showInputBox({ prompt: 'Enter 10-Point CGPA (e.g. 8.6)', value: '8.6' });
    if (!raw) return;
    const cgpa = parseFloat(raw) || 0;
    const cbse = Math.min(100, Math.max(0, cgpa * 9.5)).toFixed(2);
    const dec = Math.min(100, Math.max(0, cgpa * 10.0)).toFixed(2);
    const aicte = Math.min(100, Math.max(0, (cgpa - 0.75) * 10.0)).toFixed(2);
    vscode.window.showInformationMessage(
      `CGPA ${cgpa.toFixed(2)} -> CBSE/UGC (9.5x): ${cbse}% | Direct (10x): ${dec}% | AICTE: ${aicte}% (Full solver: https://zeeml.com/cgpa-calculator)`
    );
  });

  context.subscriptions.push(cmdCsv, cmdCsvToJson, cmdMd, cmdCadence, cmdCgpa);
}

function deactivate() {}
module.exports = { activate, deactivate, flattenObject, escapeCsvCell, jsonToCsv, csvToJson, jsonToMarkdown, computeCadence };
