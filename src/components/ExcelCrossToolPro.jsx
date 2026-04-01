import { useState, useMemo, useCallback, useRef } from "react";
import * as XLSX from "xlsx";

// ─── Utilities ────────────────────────────────────────────────────────────────

const normalize = (v) =>
  String(v ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const levenshtein = (a, b) => {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = [];
  for (let i = 0; i <= a.length; i++) m[i] = [i];
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      m[i][j] =
        a[i - 1] === b[j - 1]
          ? m[i - 1][j - 1]
          : 1 + Math.min(m[i - 1][j - 1], m[i][j - 1], m[i - 1][j]);
  return m[a.length][b.length];
};

const similarity = (a, b) => {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  if (!maxLen) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
};

// ─── Core comparison engine ────────────────────────────────────────────────────

function compareFiles(fileA, fileB, keyColumns, threshold = 0.82) {
  const results = [];

  for (const rowA of fileA) {
    const keyA = keyColumns.map((k) => String(rowA[k] ?? "")).join("|");

    let bestMatch = null;
    let bestScore = 0;

    for (const rowB of fileB) {
      const keyB = keyColumns.map((k) => String(rowB[k] ?? "")).join("|");
      const score = similarity(keyA, keyB);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = rowB;
      }
    }

    if (bestMatch && bestScore >= threshold) {
      const allCols = Array.from(
        new Set([...Object.keys(rowA), ...Object.keys(bestMatch)])
      );
      const merged = {};
      const diffs = {};

      for (const col of allCols) {
        const valA = rowA[col] ?? "";
        const valB = bestMatch[col] ?? "";
        merged[col] = { a: valA, b: valB };
        diffs[col] = normalize(String(valA)) !== normalize(String(valB));
      }

      results.push({ merged, diffs, matchScore: bestScore, status: "matched" });
    } else {
      const cols = Object.keys(rowA);
      const merged = {};
      const diffs = {};
      for (const col of cols) {
        merged[col] = { a: rowA[col] ?? "", b: "" };
        diffs[col] = false;
      }
      results.push({ merged, diffs, matchScore: 0, status: "only_a" });
    }
  }

  // Rows only in B
  for (const rowB of fileB) {
    const keyB = keyColumns.map((k) => String(rowB[k] ?? "")).join("|");
    const alreadyMatched = results.some((r) => {
      if (r.status !== "matched") return false;
      const kb = keyColumns
        .map((k) => String(r.merged[k]?.b ?? ""))
        .join("|");
      return similarity(keyB, kb) >= threshold;
    });
    if (!alreadyMatched) {
      const merged = {};
      const diffs = {};
      for (const col of Object.keys(rowB)) {
        merged[col] = { a: "", b: rowB[col] ?? "" };
        diffs[col] = false;
      }
      results.push({ merged, diffs, matchScore: 0, status: "only_b" });
    }
  }

  return results;
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function DropZone({ index, data, onFile, label }) {
  const inputRef = useRef();
  const [dragging, setDragging] = useState(false);

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) onFile(file, index);
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      className={`dropzone ${dragging ? "dragging" : ""} ${data ? "loaded" : ""}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        style={{ display: "none" }}
        onChange={(e) => { if (e.target.files[0]) onFile(e.target.files[0], index); }}
      />
      <div className="dz-icon">
        {data ? (
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <polyline points="9 15 12 18 15 15"/>
            <line x1="12" y1="10" x2="12" y2="18"/>
          </svg>
        ) : (
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
        )}
      </div>
      <div className="dz-label">{label}</div>
      <div className="dz-sub">
        {data ? `${data.rows} filas · ${data.cols} columnas` : "Arrastrar o hacer clic"}
      </div>
      {data && <div className="dz-name">{data.name}</div>}
    </div>
  );
}

function Badge({ status }) {
  const map = {
    matched: { label: "Coincide", cls: "badge-match" },
    only_a:  { label: "Solo en A", cls: "badge-a" },
    only_b:  { label: "Solo en B", cls: "badge-b" },
  };
  const { label, cls } = map[status] || {};
  return <span className={`badge ${cls}`}>{label}</span>;
}

// ─── Main Component ────────────────────────────────────────────────────────────

export default function ExcelComparator() {
  const [files, setFiles] = useState([null, null]);
  const [rawData, setRawData] = useState([null, null]);
  const [keyColumns, setKeyColumns] = useState([]);
  const [threshold, setThreshold] = useState(82);
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterDiff, setFilterDiff] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [expandedRow, setExpandedRow] = useState(null);
  const PER_PAGE = 25;

  const allColumns = useMemo(() => {
    const cols = new Set();
    rawData.forEach(d => d?.json?.forEach(r => Object.keys(r).forEach(k => cols.add(k))));
    return Array.from(cols);
  }, [rawData]);

  const sharedColumns = useMemo(() => {
    if (!rawData[0] || !rawData[1]) return [];
    const aKeys = new Set(Object.keys(rawData[0].json[0] || {}));
    const bKeys = new Set(Object.keys(rawData[1].json[0] || {}));
    return [...aKeys].filter(k => bKeys.has(k));
  }, [rawData]);

  const readFile = useCallback((file, index) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const wb = XLSX.read(e.target.result, { type: "binary" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json(ws, { defval: "" });
      const newRaw = [...rawData];
      newRaw[index] = { json, name: file.name, rows: json.length, cols: Object.keys(json[0] || {}).length };
      setRawData(newRaw);
      const newFiles = [...files];
      newFiles[index] = file;
      setFiles(newFiles);
      setResults(null);
      setKeyColumns([]);
    };
    reader.readAsBinaryString(file);
  }, [rawData, files]);

  const runComparison = useCallback(() => {
    if (!rawData[0] || !rawData[1] || keyColumns.length === 0) return;
    setLoading(true);
    setTimeout(() => {
      const res = compareFiles(rawData[0].json, rawData[1].json, keyColumns, threshold / 100);
      setResults(res);
      setPage(1);
      setLoading(false);
    }, 50);
  }, [rawData, keyColumns, threshold]);

  const stats = useMemo(() => {
    if (!results) return null;
    const matched = results.filter(r => r.status === "matched");
    const withDiff = matched.filter(r => Object.values(r.diffs).some(Boolean));
    return {
      total: results.length,
      matched: matched.length,
      only_a: results.filter(r => r.status === "only_a").length,
      only_b: results.filter(r => r.status === "only_b").length,
      withDiff: withDiff.length,
    };
  }, [results]);

  const filtered = useMemo(() => {
    if (!results) return [];
    return results.filter(r => {
      if (filterStatus !== "all" && r.status !== filterStatus) return false;
      if (filterDiff && !Object.values(r.diffs).some(Boolean)) return false;
      if (search) {
        const s = search.toLowerCase();
        return Object.values(r.merged).some(v =>
          String(v.a).toLowerCase().includes(s) || String(v.b).toLowerCase().includes(s)
        );
      }
      return true;
    });
  }, [results, filterStatus, filterDiff, search]);

  const paginated = useMemo(() => {
    const start = (page - 1) * PER_PAGE;
    return filtered.slice(start, start + PER_PAGE);
  }, [filtered, page]);

  const totalPages = Math.ceil(filtered.length / PER_PAGE);

  const exportResult = () => {
    if (!results) return;
    const cols = results.length > 0 ? Object.keys(results[0].merged) : [];
    const rows = results.map(r => {
      const row = { _estado: r.status, _similitud: Math.round(r.matchScore * 100) + "%" };
      cols.forEach(c => {
        row[`${c}_A`] = r.merged[c]?.a ?? "";
        row[`${c}_B`] = r.merged[c]?.b ?? "";
        row[`${c}_diferente`] = r.diffs[c] ? "SI" : "";
      });
      return row;
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Comparación");
    XLSX.writeFile(wb, "comparacion_resultado.xlsx");
  };

  const canCompare = rawData[0] && rawData[1] && keyColumns.length > 0;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@400;600;700;800&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
          --bg: #0a0c10;
          --surface: #111318;
          --surface2: #181c23;
          --border: #232730;
          --border2: #2e3440;
          --accent: #4ade80;
          --accent2: #22c55e;
          --amber: #fbbf24;
          --rose: #f87171;
          --blue: #60a5fa;
          --muted: #4b5563;
          --text: #e2e8f0;
          --text2: #94a3b8;
          --font-head: 'Syne', sans-serif;
          --font-mono: 'DM Mono', monospace;
          --radius: 10px;
        }

        body { background: var(--bg); color: var(--text); font-family: var(--font-mono); }

        .app {
          min-height: 100vh;
          padding: 32px 24px 64px;
          max-width: 1400px;
          margin: 0 auto;
        }

        /* Header */
        .header {
          display: flex;
          align-items: center;
          gap: 16px;
          margin-bottom: 40px;
        }
        .header-icon {
          width: 44px; height: 44px;
          background: linear-gradient(135deg, var(--accent), #16a34a);
          border-radius: 10px;
          display: grid; place-items: center;
          color: #000;
          flex-shrink: 0;
        }
        .header-title { font-family: var(--font-head); font-size: 1.5rem; font-weight: 800; letter-spacing: -0.02em; }
        .header-sub { font-size: 0.75rem; color: var(--text2); margin-top: 2px; }

        /* Steps */
        .steps { display: flex; flex-direction: column; gap: 24px; }

        .step-card {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          overflow: hidden;
        }
        .step-header {
          display: flex; align-items: center; gap: 12px;
          padding: 16px 20px;
          border-bottom: 1px solid var(--border);
          background: var(--surface2);
        }
        .step-num {
          width: 24px; height: 24px;
          background: var(--accent);
          color: #000;
          border-radius: 50%;
          display: grid; place-items: center;
          font-size: 0.7rem; font-weight: 700;
          flex-shrink: 0;
        }
        .step-num.done { background: var(--accent2); }
        .step-title { font-family: var(--font-head); font-size: 0.875rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; }
        .step-body { padding: 20px; }

        /* Drop zones */
        .dropzones { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        @media (max-width: 600px) { .dropzones { grid-template-columns: 1fr; } }

        .dropzone {
          border: 2px dashed var(--border2);
          border-radius: var(--radius);
          padding: 28px 20px;
          cursor: pointer;
          text-align: center;
          transition: all 0.2s;
          background: var(--surface2);
        }
        .dropzone:hover, .dropzone.dragging {
          border-color: var(--accent);
          background: rgba(74, 222, 128, 0.05);
        }
        .dropzone.loaded {
          border-color: var(--accent2);
          border-style: solid;
          background: rgba(34, 197, 94, 0.07);
        }
        .dz-icon { color: var(--text2); margin-bottom: 10px; }
        .dropzone.loaded .dz-icon { color: var(--accent); }
        .dz-label { font-family: var(--font-head); font-size: 0.875rem; font-weight: 700; color: var(--text); margin-bottom: 4px; }
        .dz-sub { font-size: 0.7rem; color: var(--text2); }
        .dz-name { font-size: 0.7rem; color: var(--accent); margin-top: 6px; font-weight: 500; }

        /* Key columns */
        .col-grid { display: flex; flex-wrap: wrap; gap: 8px; }
        .col-chip {
          display: flex; align-items: center; gap: 6px;
          padding: 6px 12px;
          border-radius: 6px;
          border: 1px solid var(--border2);
          background: var(--surface2);
          cursor: pointer;
          font-size: 0.75rem;
          transition: all 0.15s;
          user-select: none;
          color: var(--text2);
        }
        .col-chip:hover { border-color: var(--accent); color: var(--text); }
        .col-chip.active {
          border-color: var(--accent);
          background: rgba(74, 222, 128, 0.12);
          color: var(--accent);
        }
        .col-chip input { display: none; }

        /* Threshold */
        .threshold-row { display: flex; align-items: center; gap: 16px; margin-top: 16px; }
        .threshold-label { font-size: 0.75rem; color: var(--text2); flex-shrink: 0; }
        .threshold-val {
          font-size: 0.875rem; font-weight: 700; color: var(--accent);
          width: 44px; text-align: center;
        }
        input[type=range] {
          flex: 1; height: 4px;
          -webkit-appearance: none;
          background: var(--border2);
          border-radius: 2px;
          outline: none;
        }
        input[type=range]::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 16px; height: 16px;
          border-radius: 50%;
          background: var(--accent);
          cursor: pointer;
          border: 2px solid var(--bg);
        }

        /* Buttons */
        .btn-row { display: flex; gap: 12px; flex-wrap: wrap; }
        .btn {
          display: inline-flex; align-items: center; gap: 8px;
          padding: 10px 20px;
          border-radius: 8px;
          font-family: var(--font-mono);
          font-size: 0.8rem;
          font-weight: 500;
          cursor: pointer;
          border: none;
          transition: all 0.15s;
          outline: none;
        }
        .btn-primary {
          background: var(--accent);
          color: #000;
        }
        .btn-primary:hover:not(:disabled) { background: var(--accent2); transform: translateY(-1px); }
        .btn-primary:disabled { opacity: 0.35; cursor: not-allowed; }
        .btn-outline {
          background: transparent;
          border: 1px solid var(--border2);
          color: var(--text2);
        }
        .btn-outline:hover:not(:disabled) { border-color: var(--text2); color: var(--text); }
        .btn-outline:disabled { opacity: 0.35; cursor: not-allowed; }

        /* Stats */
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; }
        .stat-card {
          background: var(--surface2);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          padding: 16px;
          text-align: center;
        }
        .stat-val {  font-size: 2rem; font-weight: 800; line-height: 1; }
        .stat-label { font-size: 0.65rem; color: var(--text2); margin-top: 6px; text-transform: uppercase; letter-spacing: 0.08em; }
        .stat-card.green .stat-val { color: var(--accent); }
        .stat-card.amber .stat-val { color: var(--amber); }
        .stat-card.rose  .stat-val { color: var(--rose); }
        .stat-card.blue  .stat-val { color: var(--blue); }

        /* Filters */
        .filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 16px; }
        .filter-btn {
          padding: 5px 14px;
          border-radius: 6px;
          font-family: var(--font-mono);
          font-size: 0.72rem;
          cursor: pointer;
          border: 1px solid var(--border2);
          background: var(--surface2);
          color: var(--text2);
          transition: all 0.15s;
        }
        .filter-btn.active { background: var(--surface); border-color: var(--text2); color: var(--text); }
        .filter-toggle {
          padding: 5px 14px;
          border-radius: 6px;
          font-family: var(--font-mono);
          font-size: 0.72rem;
          cursor: pointer;
          border: 1px solid var(--border2);
          background: var(--surface2);
          color: var(--text2);
          transition: all 0.15s;
        }
        .filter-toggle.active { background: rgba(251, 191, 36, 0.12); border-color: var(--amber); color: var(--amber); }
        .search-input {
          flex: 1;
          min-width: 160px;
          padding: 6px 12px;
          background: var(--surface2);
          border: 1px solid var(--border2);
          border-radius: 6px;
          font-family: var(--font-mono);
          font-size: 0.75rem;
          color: var(--text);
          outline: none;
        }
        .search-input:focus { border-color: var(--accent); }
        .search-input::placeholder { color: var(--muted); }

        /* Table */
        .table-wrap {
          overflow-x: auto;
          border: 1px solid var(--border);
          border-radius: var(--radius);
        }
        table { width: 100%; border-collapse: collapse; font-size: 0.75rem; }
        thead { background: var(--surface2); position: sticky; top: 0; z-index: 10; }
        th {
          padding: 10px 14px;
          text-align: left;
          font-family: var(--font-head);
          font-size: 0.65rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--text2);
          border-bottom: 1px solid var(--border);
          white-space: nowrap;
        }
        td {
          padding: 10px 14px;
          border-bottom: 1px solid var(--border);
          color: var(--text2);
          vertical-align: middle;
          white-space: nowrap;
        }
        tr:last-child td { border-bottom: none; }
        tr:hover td { background: rgba(255,255,255,0.02); }
        tr.expanded td { background: rgba(74,222,128,0.04); }

        td.changed { background: rgba(251,191,36,0.08) !important; }
        .cell-diff {
          display: flex; flex-direction: column; gap: 2px;
        }
        .cell-a { color: var(--rose); text-decoration: line-through; font-size: 0.68rem; }
        .cell-b { color: var(--accent); font-size: 0.72rem; }
        .cell-same { color: var(--text2); }

        /* Badge */
        .badge {
          display: inline-block;
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 0.65rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }
        .badge-match { background: rgba(74,222,128,0.12); color: var(--accent); }
        .badge-a { background: rgba(248,113,113,0.12); color: var(--rose); }
        .badge-b { background: rgba(96,165,250,0.12); color: var(--blue); }

        .score-pill {
          display: inline-block;
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 0.65rem;
          background: var(--surface2);
          color: var(--text2);
        }
        .score-pill.high { color: var(--accent); }
        .score-pill.med  { color: var(--amber); }
        .score-pill.low  { color: var(--rose); }

        /* Expanded detail */
        .detail-row td { background: var(--surface2) !important; }
        .detail-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; padding: 12px 4px; }
        .detail-item { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 10px; }
        .detail-col { font-size: 0.65rem; color: var(--text2); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; }
        .detail-vals { display: flex; flex-direction: column; gap: 4px; }
        .detail-src { font-size: 0.68rem; }
        .detail-src span { font-size: 0.6rem; color: var(--muted); margin-right: 4px; text-transform: uppercase; }
        .detail-item.changed { border-color: var(--amber); }
        .detail-item.changed .detail-col { color: var(--amber); }

        /* Pagination */
        .pagination { display: flex; align-items: center; gap: 8px; justify-content: center; margin-top: 16px; }
        .pg-btn {
          padding: 5px 12px;
          border-radius: 6px;
          border: 1px solid var(--border2);
          background: var(--surface2);
          color: var(--text2);
          font-family: var(--font-mono);
          font-size: 0.72rem;
          cursor: pointer;
          transition: all 0.15s;
        }
        .pg-btn:hover:not(:disabled) { border-color: var(--text); color: var(--text); }
        .pg-btn:disabled { opacity: 0.35; cursor: not-allowed; }
        .pg-info { font-size: 0.72rem; color: var(--text2); }

        /* Loading */
        .loading-overlay {
          display: flex; align-items: center; justify-content: center;
          gap: 10px; padding: 40px;
          color: var(--text2); font-size: 0.8rem;
        }
        .spinner {
          width: 18px; height: 18px;
          border: 2px solid var(--border2);
          border-top-color: var(--accent);
          border-radius: 50%;
          animation: spin 0.6s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        .empty { text-align: center; padding: 48px; color: var(--muted); font-size: 0.8rem; }
        .hint { font-size: 0.7rem; color: var(--muted); margin-top: 8px; }
        .divider { width: 1px; background: var(--border2); height: 20px; flex-shrink: 0; margin: 0 2px; }
        .count-badge {
          background: var(--surface2);
          border: 1px solid var(--border);
          border-radius: 4px;
          padding: 1px 7px;
          font-size: 0.65rem;
          color: var(--text2);
          margin-left: auto;
        }
        .no-files { font-size: 0.75rem; color: var(--muted); padding: 8px 0; }
      `}</style>

      <div className="app">
        {/* Header */}
        <div className="header">
          <div className="header-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
              <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
            </svg>
          </div>
          <div>
            <div className="header-title">Comparador de Datos</div>
            <div className="header-sub">Cruzamiento inteligente con detección de diferencias</div>
          </div>
          {results && (
            <button onClick={exportResult} className="btn btn-outline" style={{ marginLeft: "auto" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              Exportar .xlsx
            </button>
          )}
        </div>

        <div className="steps">
          {/* Step 1 */}
          <div className="step-card">
            <div className="step-header">
              <div className={`step-num ${rawData[0] && rawData[1] ? "done" : ""}`}>1</div>
              <div className="step-title">Cargar archivos</div>
              {rawData[0] && rawData[1] && (
                <span style={{ marginLeft: "auto", fontSize: "0.7rem", color: "var(--accent)" }}>✓ Listos</span>
              )}
            </div>
            <div className="step-body">
              <div className="dropzones">
                <DropZone index={0} data={rawData[0]} onFile={readFile} label="Archivo A (base)" />
                <DropZone index={1} data={rawData[1]} onFile={readFile} label="Archivo B (comparar)" />
              </div>
            </div>
          </div>

          {/* Step 2 */}
          <div className="step-card">
            <div className="step-header">
              <div className={`step-num ${keyColumns.length > 0 ? "done" : ""}`}>2</div>
              <div className="step-title">Columnas clave para cruzar</div>
              {keyColumns.length > 0 && (
                <span className="count-badge">{keyColumns.length} seleccionada{keyColumns.length !== 1 ? "s" : ""}</span>
              )}
            </div>
            <div className="step-body">
              {allColumns.length > 0 ? (
                <>
                  <div className="col-grid">
                    {allColumns.map(col => (
                      <label key={col} className={`col-chip ${keyColumns.includes(col) ? "active" : ""}`}>
                        <input
                          type="checkbox"
                          checked={keyColumns.includes(col)}
                          onChange={(e) => {
                            setKeyColumns(prev =>
                              e.target.checked ? [...prev, col] : prev.filter(x => x !== col)
                            );
                          }}
                        />
                        {col}
                      </label>
                    ))}
                  </div>
                  <div className="threshold-row">
                    <span className="threshold-label">Umbral similitud</span>
                    <input
                      type="range" min={50} max={100} value={threshold}
                      onChange={e => setThreshold(Number(e.target.value))}
                    />
                    <span className="threshold-val">{threshold}%</span>
                    <span className="hint" style={{ marginTop: 0 }}>
                      {threshold >= 95 ? "Exacto" : threshold >= 80 ? "Fuzzy moderado" : "Fuzzy amplio"}
                    </span>
                  </div>
                </>
              ) : (
                <div className="no-files">Cargá ambos archivos para ver las columnas disponibles.</div>
              )}
            </div>
          </div>

          {/* Step 3 */}
          <div className="step-card">
            <div className="step-header">
              <div className="step-num">3</div>
              <div className="step-title">Ejecutar comparación</div>
            </div>
            <div className="step-body">
              <div className="btn-row">
                <button className="btn btn-primary" onClick={runComparison} disabled={!canCompare || loading}>
                  {loading ? (
                    <><div className="spinner" /> Procesando...</>
                  ) : (
                    <>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                      </svg>
                      Comparar archivos
                    </>
                  )}
                </button>
                {results && (
                  <button className="btn btn-outline" onClick={() => { setResults(null); setFiles([null,null]); setRawData([null,null]); setKeyColumns([]); }}>
                    Reiniciar
                  </button>
                )}
              </div>
              {!canCompare && !loading && (
                <div className="hint" style={{ marginTop: 12 }}>
                  {!rawData[0] || !rawData[1] ? "• Falta cargar archivos." : ""}
                  {keyColumns.length === 0 ? "  • Seleccioná al menos una columna clave." : ""}
                </div>
              )}
            </div>
          </div>

          {/* Results */}
          {loading && (
            <div className="step-card">
              <div className="loading-overlay">
                <div className="spinner" />
                Analizando y cruzando datos...
              </div>
            </div>
          )}

          {results && !loading && (
            <>
              {/* Stats */}
              <div className="stats-grid">
                <div className="stat-card">
                  <div className="stat-val" style={{ color: "var(--text)" }}>{stats.total}</div>
                  <div className="stat-label">Total filas</div>
                </div>
                <div className="stat-card green">
                  <div className="stat-val">{stats.matched}</div>
                  <div className="stat-label">Coincidencias</div>
                </div>
                <div className="stat-card amber">
                  <div className="stat-val">{stats.withDiff}</div>
                  <div className="stat-label">Con diferencias</div>
                </div>
                <div className="stat-card rose">
                  <div className="stat-val">{stats.only_a}</div>
                  <div className="stat-label">Solo en A</div>
                </div>
                <div className="stat-card blue">
                  <div className="stat-val">{stats.only_b}</div>
                  <div className="stat-label">Solo en B</div>
                </div>
              </div>

              {/* Table */}
              <div className="step-card">
                <div className="step-header">
                  <div className="step-num done">✓</div>
                  <div className="step-title">Resultados</div>
                  <span className="count-badge">{filtered.length} filas</span>
                </div>
                <div className="step-body" style={{ padding: "16px" }}>
                  {/* Filters */}
                  <div className="filters">
                    {[["all","Todos"],["matched","Coinciden"],["only_a","Solo A"],["only_b","Solo B"]].map(([val, lbl]) => (
                      <button key={val} className={`filter-btn ${filterStatus === val ? "active" : ""}`}
                        onClick={() => { setFilterStatus(val); setPage(1); }}>
                        {lbl}
                      </button>
                    ))}
                    <div className="divider" />
                    <button className={`filter-toggle ${filterDiff ? "active" : ""}`}
                      onClick={() => { setFilterDiff(v => !v); setPage(1); }}>
                      ⚡ Solo con cambios
                    </button>
                    <div className="divider" />
                    <input
                      className="search-input"
                      placeholder="Buscar en resultados..."
                      value={search}
                      onChange={e => { setSearch(e.target.value); setPage(1); }}
                    />
                  </div>

                  {paginated.length === 0 ? (
                    <div className="empty">No hay resultados con los filtros actuales.</div>
                  ) : (
                    <>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th style={{ width: 32 }}></th>
                              <th>Estado</th>
                              <th>Similitud</th>
                              {Object.keys(paginated[0].merged).map(col => (
                                <th key={col}>{col}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {paginated.map((row, ri) => {
                              const globalIdx = (page - 1) * PER_PAGE + ri;
                              const isExpanded = expandedRow === globalIdx;
                              const hasDiff = Object.values(row.diffs).some(Boolean);
                              return (
                                <>
                                  <tr
                                    key={ri}
                                    className={isExpanded ? "expanded" : ""}
                                    style={{ cursor: "pointer" }}
                                    onClick={() => setExpandedRow(isExpanded ? null : globalIdx)}
                                  >
                                    <td style={{ color: "var(--muted)", fontSize: "0.7rem", textAlign: "center" }}>
                                      {isExpanded ? "▼" : "▶"}
                                    </td>
                                    <td><Badge status={row.status} /></td>
                                    <td>
                                      {row.status === "matched" ? (
                                        <span className={`score-pill ${row.matchScore >= 0.95 ? "high" : row.matchScore >= 0.82 ? "med" : "low"}`}>
                                          {Math.round(row.matchScore * 100)}%
                                        </span>
                                      ) : <span className="score-pill">—</span>}
                                    </td>
                                    {Object.keys(row.merged).map((col, ci) => {
                                      const cell = row.merged[col];
                                      const changed = row.diffs[col];
                                      return (
                                        <td key={ci} className={changed ? "changed" : ""}>
                                          {changed ? (
                                            <div className="cell-diff">
                                              <span className="cell-a">{String(cell.a)}</span>
                                              <span className="cell-b">{String(cell.b)}</span>
                                            </div>
                                          ) : (
                                            <span className="cell-same">{String(cell.a || cell.b)}</span>
                                          )}
                                        </td>
                                      );
                                    })}
                                  </tr>
                                  {isExpanded && (
                                    <tr className="detail-row">
                                      <td colSpan={Object.keys(row.merged).length + 3}>
                                        <div className="detail-grid">
                                          {Object.keys(row.merged).map(col => {
                                            const cell = row.merged[col];
                                            const changed = row.diffs[col];
                                            return (
                                              <div key={col} className={`detail-item ${changed ? "changed" : ""}`}>
                                                <div className="detail-col">{col}</div>
                                                <div className="detail-vals">
                                                  <div className="detail-src"><span>A</span>{String(cell.a)}</div>
                                                  {row.status === "matched" && (
                                                    <div className="detail-src"><span>B</span>{String(cell.b)}</div>
                                                  )}
                                                </div>
                                              </div>
                                            );
                                          })}
                                        </div>
                                      </td>
                                    </tr>
                                  )}
                                </>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>

                      {totalPages > 1 && (
                        <div className="pagination">
                          <button className="pg-btn" disabled={page === 1} onClick={() => setPage(1)}>«</button>
                          <button className="pg-btn" disabled={page === 1} onClick={() => setPage(p => p - 1)}>‹</button>
                          <span className="pg-info">Página {page} de {totalPages} · {filtered.length} filas</span>
                          <button className="pg-btn" disabled={page === totalPages} onClick={() => setPage(p => p + 1)}>›</button>
                          <button className="pg-btn" disabled={page === totalPages} onClick={() => setPage(totalPages)}>»</button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
