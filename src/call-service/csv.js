function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted && char === '"' && text[index + 1] === '"') { field += '"'; index += 1; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (!quoted && char === ",") { row.push(field); field = ""; continue; }
    if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field); if (row.some((value) => value.trim())) rows.push(row); row = []; field = ""; continue;
    }
    field += char;
  }
  if (quoted) throw new Error("CSV has an unclosed quoted field.");
  row.push(field); if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

export function parseContactsCsv(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("CSV is empty.");
  const rows = parseCsv(input.replace(/^\uFEFF/, ""));
  if (rows.length < 2) throw new Error("CSV does not contain contact records.");
  const headers = rows[0].map((value) => value.trim().toLowerCase());
  const nameIndex = headers.indexOf("nombre");
  const phoneIndex = headers.findIndex((header) => ["telefono", "teléfono", "phone"].includes(header));
  if (nameIndex < 0 || phoneIndex < 0) throw new Error("CSV requires columns 'nombre' and 'telefono'.");
  if (rows.length - 1 > 500) throw new Error("CSV supports at most 500 contacts per campaign.");
  return rows.slice(1).map((row, index) => {
    if (row.length !== headers.length) throw new Error(`Row ${index + 2} has an invalid number of columns.`);
    const name = row[nameIndex].trim(), phone = row[phoneIndex].trim();
    if (!name || !phone) throw new Error(`Row ${index + 2} requires nombre and telefono.`);
    const context = Object.fromEntries(headers.map((header, column) => [header, row[column].trim()]).filter(([header]) => !["nombre", "telefono", "teléfono", "phone"].includes(header)));
    return { name, phone, context };
  });
}
