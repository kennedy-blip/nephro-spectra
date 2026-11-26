/**
 * NEPHRO-SPECTRA — clinical report exporter.
 *
 * Produces a self-contained, print-ready HTML document (plus a JSON payload and
 * a CSV flattening) from any module's computed state. No external libraries, no
 * network calls — the document is assembled as a Blob and downloaded locally so
 * it works identically in the Vercel web app and the offline Android APK.
 *
 * No TypeScript.
 */

import { ref, computed } from 'vue'

export const REPORT_SCHEMA = 'nephro-spectra/report/v28'

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fmt(v, digits = 2) {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '—'
    return Number.isInteger(v) ? String(v) : v.toFixed(digits)
  }
  return String(v)
}

function badge(level) {
  const map = {
    normal: '#1f7a5c',
    info: '#2b5f8f',
    warn: '#9a6b16',
    danger: '#9d2b2b',
    high: '#9d2b2b',
    moderate: '#9a6b16',
    low: '#1f7a5c'
  }
  const c = map[level] || '#465569'
  return `background:${c};color:#fff;padding:2px 8px;border-radius:999px;font-size:10px;letter-spacing:.08em;text-transform:uppercase`
}

/** Envelope shared by every module report. */
function envelope({ title, module, role, patientRef, summary, sections, payload }) {
  return {
    schema: REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    title,
    module,
    role,
    patientRef: patientRef || 'ANON-DEMO-REF',
    summary,
    sections,
    payload
  }
}

/** Render a report object to a standalone HTML string. */
export function renderReportHtml(report) {
  const rows = (rowsList) =>
    rowsList
      .map(
        (r) => `<tr><th>${esc(r.label)}</th><td>${r.value !== undefined && r.level
          ? `<span style="${badge(r.level)}">${esc(r.value)}</span>`
          : esc(fmt(r.value, r.digits))}${r.unit ? ` <span class="unit">${esc(r.unit)}</span>` : ''}</td><td class="note">${esc(r.note || '')}</td></tr>`
      )
      .join('')

  const sectionHtml = report.sections
    .map(
      (s) => `<section>
        <h2>${esc(s.heading)}</h2>
        ${s.intro ? `<p class="intro">${esc(s.intro)}</p>` : ''}
        ${s.rows?.length ? `<table>${rows(s.rows)}</table>` : ''}
        ${s.findings?.length
          ? `<ul class="findings">${s.findings.map((f) => `<li><span style="${badge(f.level)}">${esc(f.level)}</span> ${esc(f.text)}</li>`).join('')}</ul>`
          : ''}
        ${s.trace?.length ? `<div class="trace">${esc(s.trace)}</div>` : ''}
      </section>`
    )
    .join('')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>${esc(report.title)} — NEPHRO-SPECTRA</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font: 13px/1.55 -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 40px 46px; color: #16212e; background: #fbfcfe; }
  header { border-bottom: 2px solid #0f2033; padding-bottom: 16px; margin-bottom: 26px; display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; }
  .brand { font-size: 11px; letter-spacing: .28em; text-transform: uppercase; color: #5b6d84; }
  h1 { font-size: 22px; margin: 4px 0 2px; letter-spacing: -0.01em; }
  .meta { font-size: 11px; color: #5b6d84; text-align: right; line-height: 1.7; }
  h2 { font-size: 12px; letter-spacing: .16em; text-transform: uppercase; color: #0f2033; margin: 28px 0 10px; padding-bottom: 6px; border-bottom: 1px solid #dde5ef; }
  table { width: 100%; border-collapse: collapse; margin: 6px 0 4px; }
  tr { border-bottom: 1px solid #eef3f9; }
  th { text-align: left; font-weight: 600; width: 30%; padding: 7px 10px 7px 0; color: #33455c; font-size: 12px; vertical-align: top; }
  td { padding: 7px 10px 7px 0; font-variant-numeric: tabular-nums; }
  td.note { color: #64748b; font-size: 11.5px; }
  .unit { color: #8296ad; font-size: 11px; }
  .intro { color: #465569; font-size: 12.5px; margin: 4px 0 10px; }
  ul.findings { list-style: none; padding: 0; margin: 10px 0; }
  ul.findings li { padding: 7px 0; border-bottom: 1px solid #eef3f9; font-size: 12.5px; }
  .trace { font: 11px/1.5 ui-monospace, monospace; background: #0f2033; color: #b8e6d8; padding: 14px 16px; border-radius: 8px; white-space: pre-wrap; overflow-x: auto; }
  footer { margin-top: 34px; border-top: 1px solid #dde5ef; padding-top: 14px; font-size: 10.5px; color: #7b8ca3; line-height: 1.7; }
  .disclaimer { background: #fff8ea; border-left: 3px solid #d9a441; padding: 10px 14px; font-size: 11.5px; color: #6b5220; margin-top: 14px; }
  @media print { body { padding: 18px; } h2 { break-after: avoid; } section { break-inside: avoid; } }
</style></head>
<body>
  <header>
    <div>
      <div class="brand">Nephro-Spectra · Clinical Workstation v28</div>
      <h1>${esc(report.title)}</h1>
      <div class="brand" style="letter-spacing:.06em;text-transform:none;font-size:11.5px;color:#465569">${esc(report.module)}</div>
    </div>
    <div class="meta">
      Generated ${esc(new Date(report.generatedAt).toISOString().replace('T', ' ').slice(0, 19))} UTC<br />
      Operator tier: ${esc(report.role)}<br />
      Record: ${esc(report.patientRef)}<br />
      Schema: ${esc(report.schema)}
    </div>
  </header>
  <p class="intro">${esc(report.summary)}</p>
  ${sectionHtml}
  <div class="disclaimer">Decision support only. All values are derived from deterministic in-browser models and are not a diagnosis. Confirm every result against validated laboratory methods and local clinical governance before acting on it.</div>
  <footer>
    NEPHRO-SPECTRA v28.0.0-polyglot · Vue 3.5 · Rust/WASM DSP · Go 1.22 supersaturation · Java 17 Capacitor plugins<br />
    IndexedDB vault <code>nephro_spectra_vault_v1</code> · report schema ${esc(report.schema)}
  </footer>
</body></html>`
}

/** Flatten sections to CSV. */
export function renderReportCsv(report) {
  const lines = [['section', 'field', 'value', 'unit', 'level', 'note'].join(',')]
  for (const s of report.sections) {
    for (const r of s.rows || []) {
      lines.push([s.heading, r.label, r.value ?? '', r.unit ?? '', r.level ?? '', r.note ?? ''].map(csvCell).join(','))
    }
    for (const f of s.findings || []) {
      lines.push([s.heading, 'finding', f.text, '', f.level, ''].map(csvCell).join(','))
    }
  }
  return lines.join('\n')
}

function csvCell(v) {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function download(filename, content, mime) {
  if (typeof document === 'undefined') return null
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
  return { filename, bytes: blob.size }
}

export function useReportExporter() {
  const lastExport = ref(null)
  const history = ref([])

  function exportReport(report, { format = 'html' } = {}) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const base = `nephro-spectra_${report.module.toLowerCase().replace(/[^a-z0-9]+/g, '-')}_${stamp}`
    let result = null
    if (format === 'html') {
      result = download(`${base}.html`, renderReportHtml(report), 'text/html;charset=utf-8')
    } else if (format === 'csv') {
      result = download(`${base}.csv`, renderReportCsv(report), 'text/csv;charset=utf-8')
    } else {
      result = download(`${base}.json`, JSON.stringify(report, null, 2), 'application/json')
    }
    if (result) {
      lastExport.value = { ...result, format, at: new Date().toISOString(), title: report.title }
      history.value = [lastExport.value, ...history.value].slice(0, 8)
    }
    return result
  }

  function previewHtml(report) {
    return renderReportHtml(report)
  }

  const totalExports = computed(() => history.value.length)

  return { exportReport, previewHtml, lastExport, history, totalExports, renderReportHtml, renderReportCsv }
}

export { envelope as buildReportEnvelope, badge as reportBadgeStyle }
