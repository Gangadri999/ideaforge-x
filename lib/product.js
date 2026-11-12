export function splitCsvRow(line, delimiter = ",") {
  const cells = []; let value = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && quoted && line[i + 1] === '"') { value += '"'; i++; }
    else if (ch === '"') quoted = !quoted;
    else if (ch === delimiter && !quoted) { cells.push(value.trim()); value = ""; }
    else value += ch;
  }
  cells.push(value.trim());
  return cells;
}

export function parseRoster(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const first = lines[0] || "";
  const delimiter = first.includes("\t") ? "\t" : first.includes(";") && !first.includes(",") ? ";" : ",";
  const rows = lines.map((line) => {
    const p = splitCsvRow(line, delimiter);
    let team = "", email = "";
    for (const x of [p[2] || "", p[3] || ""]) {
      if (/@/.test(x)) email = x.toLowerCase().slice(0, 120);
      else if (x) team = x.slice(0, 40);
    }
    return { roll: (p[0] || "").slice(0, 40), name: (p[1] || "").slice(0, 80), team, email };
  });
  if (rows.length && /^(roll|rollno|roll no|id|reg|regno)/i.test(rows[0].roll) && /name/i.test(rows[0].name)) rows.shift();
  return rows.slice(0, 200);
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return null;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : null;
}

export function fallbackRoadmap() {
  return ["Confirm the user problem and define success measures", "Review the linked literature and comparable projects", "Plan the data, architecture and evaluation", "Build a small working prototype", "Implement the core feature", "Test with intended users and record results", "Improve reliability and document limitations", "Prepare the final demo and report"]
    .map((title, i) => ({ week: i + 1, title, deliverable: "A reviewed project milestone", checkpoint: "Save evidence of completion" }));
}

export function csvCell(value) {
  let text = String(value ?? "");
  if (typeof value === "string" && /^[\t\r\n ]*[=+\-@]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
