import fs from "fs";
import path from "path";

const dir = "C:/Users/akkha/TicketX/workflow-tooling/promptx_tools/workflow/Workflow latest_postgres";

const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

let createdCount = 0;

files.forEach(file => {
  const filePath = path.join(dir, file);
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
    // 1. Raw Flow format (For Canvas 3 dots -> Import Flow)
    const rawFileName = file.replace('.json', '') + '_canvas_import.json';
    const rawPath = path.join(dir, rawFileName);
    fs.writeFileSync(rawPath, JSON.stringify(rawFlow, null, 2), "utf8");

    // 2. Overwrite standard .json file with rawFlow so Canvas Import works directly on .json!
    fs.writeFileSync(filePath, JSON.stringify(rawFlow, null, 2), "utf8");

    // 3. Template Wrapper format (For Dashboard -> Import Template)
    const templateWrapper = {
      name: rawFlow.displayName || rawFlow.name || file.replace('_postgres.json', ''),
      type: 'FLOW',
      summary: rawFlow.displayName || file,
      description: rawFlow.displayName || file,
      flows: [rawFlow]
    };
    const templateFileName = file.replace('.json', '') + '_dashboard_template.json';
    const templatePath = path.join(dir, templateFileName);
    fs.writeFileSync(templatePath, JSON.stringify(templateWrapper, null, 2), "utf8");

    createdCount++;
  }
});

console.log(`✅ Generated Canvas Import files and Dashboard Template files for ${createdCount} workflows!`);
