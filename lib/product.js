/** Small, dependency-free helpers used by IdeaForge-X server.js. */

export function parseRoster(input) {
  const lines = String(input || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  const rows = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // Accept tab-separated Excel rows, comma-separated rows, or pipe-separated rows.
    const delimiter = line.includes("\t") ? "\t" : line.includes("|") ? "|" : ",";
    const cols = line.split(delimiter).map((x) => x.trim().replace(/^\"|\"$/g, ""));
    const roll = (cols[0] || "").trim();
    const name = (cols[1] || "").trim();
    if (!roll) continue;
    // Optional columns: team, email. Also tolerate email in column 3 without a team.
    let team = (cols[2] || "").trim();
    let email = (cols[3] || "").trim();
    if (!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(team)) { email = team; team = ""; }
    rows.push({ roll: roll.slice(0, 40), name: (name || roll).slice(0, 100), team: team.slice(0, 100), email: email.slice(0, 254) });
  }
  return rows;
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return null;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]), y = Number(b[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    dot += x * y; aa += x * x; bb += y * y;
  }
  if (!aa || !bb) return null;
  return Math.max(-1, Math.min(1, dot / (Math.sqrt(aa) * Math.sqrt(bb))));
}

export function fallbackRoadmap() {
  return [
    { week: 1, title: "Define the problem and project scope", deliverable: "Problem statement and objectives", checkpoint: "Guide approves the scope" },
    { week: 2, title: "Review related work and identify the gap", deliverable: "Literature review table", checkpoint: "At least five relevant sources reviewed" },
    { week: 3, title: "Gather requirements and design the system", deliverable: "Requirements and architecture diagrams", checkpoint: "Core workflow reviewed" },
    { week: 4, title: "Prepare the development environment and prototype", deliverable: "Working prototype", checkpoint: "Main user flow runs" },
    { week: 5, title: "Implement the core features", deliverable: "First functional version", checkpoint: "Core features pass manual tests" },
    { week: 6, title: "Integrate data sources and supporting services", deliverable: "Integrated application", checkpoint: "Integration errors documented and resolved" },
    { week: 7, title: "Complete the user interface and validation", deliverable: "Usable end-to-end version", checkpoint: "Representative users complete key tasks" },
    { week: 8, title: "Test, evaluate and fix defects", deliverable: "Test report and corrected build", checkpoint: "Critical test cases pass" },
    { week: 9, title: "Analyse results and limitations", deliverable: "Evaluation results", checkpoint: "Claims are supported by recorded evidence" },
    { week: 10, title: "Prepare documentation and final presentation", deliverable: "Final report and presentation", checkpoint: "Guide review completed" },
  ];
}

export function csvCell(value) {
  const text = value == null ? "" : String(value);
  // Prevent spreadsheet formula injection as well as escaping CSV quotes.
  const safe = /^[\s]*[=+@-]/.test(text) ? "'" + text : text;
  return `"${safe.replace(/"/g, '""')}"`;
}
