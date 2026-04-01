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
