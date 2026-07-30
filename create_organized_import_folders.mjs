import fs from "fs";
import path from "path";

const baseDir = "C:/Users/akkha/TicketX/workflow-tooling/promptx_tools/workflow/Workflow latest_postgres";
const dashboardDir = path.join(baseDir, "FOR_DASHBOARD_IMPORT");
const canvasDir = path.join(baseDir, "FOR_CANVAS_IMPORT");

if (!fs.existsSync(dashboardDir)) fs.mkdirSync(dashboardDir, { recursive: true });
if (!fs.existsSync(canvasDir)) fs.mkdirSync(canvasDir, { recursive: true });

const files = fs.readdirSync(baseDir).filter(f => f.endsWith('.json') && !f.includes('_canvas_import') && !f.includes('_dashboard_template'));

files.forEach(file => {
  const filePath = path.join(baseDir, file);
  let text = fs.readFileSync(filePath, "utf8");
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  let data = JSON.parse(text);

  let rawFlow = null;
  if (Array.isArray(data)) {
    rawFlow = data[0];
  } else if (data.flows && Array.isArray(data.flows)) {
    rawFlow = data.flows[0];
  } else if (data.trigger) {
    rawFlow = data;
  }

  if (rawFlow) {
    const cleanName = file.replace(' .json', '.json');

    // 1. Raw Flow for Canvas Import (3 Dots -> Import Flow)
    fs.writeFileSync(path.join(canvasDir, cleanName), JSON.stringify(rawFlow, null, 2), "utf8");

    // 2. Template Wrapper for Dashboard Import (Dashboard -> Import Template)
    const templateWrapper = {
      name: rawFlow.displayName || cleanName.replace('.json', ''),
      type: 'FLOW',
      summary: rawFlow.displayName || cleanName.replace('.json', ''),
      description: rawFlow.displayName || cleanName.replace('.json', ''),
      flows: [rawFlow]
    };
    fs.writeFileSync(path.join(dashboardDir, cleanName), JSON.stringify(templateWrapper, null, 2), "utf8");
  }
});

console.log("✅ Created organized FOR_DASHBOARD_IMPORT and FOR_CANVAS_IMPORT folders!");
