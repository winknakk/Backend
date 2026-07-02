import * as fs from "fs";
import * as path from "path";

const nocodbDir = "c:/Users/akkha/Downloads/AutomationX/promptx_tools/workflow/nocodb";
const fixedDir = "c:/Users/akkha/Downloads/AutomationX/promptx_tools/workflow/postgres_v2_fixed";

if (!fs.existsSync(fixedDir)) {
  fs.mkdirSync(fixedDir, { recursive: true });
}

function readJsonFile(filePath: string): any {
  let content = fs.readFileSync(filePath, "utf8");
  if (content.charCodeAt(0) === 0xFEFF) {
    content = content.slice(1);
  }
  return JSON.parse(content);
}

const httpPropertySettings = {
  method: { type: "MANUAL" },
  url: { type: "MANUAL" },
  headers: { type: "MANUAL" },
  queryParams: { type: "MANUAL" },
  authType: { type: "MANUAL" },
  body_type: { type: "MANUAL" },
  body: { type: "MANUAL" }
};

const makeHttpSettings = (input: any) => {
  return {
    pieceName: "@activepieces/piece-http",
    pieceVersion: "0.11.7",
    actionName: "send_request",
    input,
    propertySettings: httpPropertySettings,
    errorHandlingOptions: {
      retryOnFailure: { value: false },
      continueOnFailure: { value: false }
    }
  };
};

function traverseAndReplace(node: any, replacements: Record<string, (settings: any) => any>): any {
  if (!node) return node;

  if (node.name && replacements[node.name]) {
    node.settings = replacements[node.name](node.settings);
    // If we changed pieceName to http, we update type
    if (node.settings.pieceName === "@activepieces/piece-http") {
      node.type = "PIECE";
    }
  }

  // Handle nextAction
  if (node.nextAction) {
    node.nextAction = traverseAndReplace(node.nextAction, replacements);
  }

  // Handle router branches
  if (node.settings && node.settings.branches) {
    for (const branch of node.settings.branches) {
      if (branch.nextAction) {
        branch.nextAction = traverseAndReplace(branch.nextAction, replacements);
      }
    }
  }

  return node;
}

// ─── 1. Main AI Core Flow ──────────────────────────────────
console.log("Migrating Main AI Core Flow...");
const mainAiContent = readJsonFile(path.join(nocodbDir, "Main AI Core Flow (NocoDB).json"));

const mainReplacements: Record<string, (settings: any) => any> = {
  step_1: () => makeHttpSettings({
    method: "GET",
    url: "http://localhost:3000/api/v1/internal/identities/search",
    headers: {},
    queryParams: {
      channel: "{{trigger.body.channel}}",
      channel_ref: "{{trigger.body.customer_ref}}"
    },
    authType: "NONE"
  }),
  step_2b: () => makeHttpSettings({
    method: "GET",
    url: "http://localhost:3000/api/v1/internal/profiles/details",
    headers: {},
    queryParams: {
      profileId: "{{step_2['profile_id']}}"
    },
    authType: "NONE"
  }),
  step_2c: () => makeHttpSettings({
    method: "GET",
    url: "http://localhost:3000/api/v1/internal/companies/details",
    headers: {},
    queryParams: {
      companyId: "{{step_2b.output.body.fields.company_id.id}}"
    },
    authType: "NONE"
  }),
  step_3: () => makeHttpSettings({
    method: "GET",
    url: "http://localhost:3000/api/v1/internal/conversations/search",
    headers: {},
    queryParams: {
      identityId: "{{step_2['identity_id']}}"
    },
    authType: "NONE"
  }),
  step_4: (settings) => {
    // Keep it as a CODE step but update sourceCode to query local endpoint
    const newCode = `const http = require('http');

const makeRequest = (url, options = {}) => {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {}
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json: async () => {
            try {
              return JSON.parse(data);
            } catch (e) {
              return data;
            }
          }
        });
      });
    });
    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
};

exports.code = async (inputs) => {
  const identity_id = inputs.identity_id;
  const channel = inputs.channel;
  const searchResults = inputs.searchResults || [];

  try {
    if (searchResults.length > 0) {
      const conv = searchResults[0];
      const fields = conv.fields || conv;
      return {
        id: conv.id || fields.id1 || fields.Id,
        identity_id: fields.identity_id || identity_id,
        status: fields.status || "open",
        handled_by: fields.handled_by || "ai"
      };
    }

    const response = await makeRequest('http://localhost:3000/api/v1/internal/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identity_id,
        channel,
        status: 'open',
        handled_by: 'ai'
      })
    });
    
    if (!response.ok) {
      throw new Error(\`HTTP error! status: \${response.status}\`);
    }
    
    const newConv = await response.json();
    const newFields = newConv.fields || newConv;
    return {
      id: newConv.id || newFields.id1 || newFields.Id,
      identity_id: newFields.identity_id || identity_id,
      status: newFields.status || "open",
      handled_by: newFields.handled_by || "ai"
    };
  } catch(e) {
    return {
      id: null,
      identity_id: identity_id,
      status: "open",
      handled_by: "ai",
      error: e instanceof Error ? e.message : String(e)
    };
  }
};`;
    return {
      ...settings,
      input: {
        searchResults: "{{step_3.output.body}}",
        identity_id: "{{step_2['identity_id']}}",
        channel: "{{trigger.body.channel}}"
      },
      sourceCode: {
        code: newCode,
        packageJson: "{}"
      }
    };
  },
  step_8: () => makeHttpSettings({
    method: "POST",
    url: "http://localhost:3000/api/v1/internal/messages",
    headers: {
      "Content-Type": "application/json"
    },
    queryParams: {},
    authType: "NONE",
    body_type: "json",
    body: {
      conversationId: "{{step_4['id']}}",
      role: "customer",
      content: "{{trigger['body']['message']}}"
    }
  }),
  step_9: () => makeHttpSettings({
    method: "GET",
    url: "http://localhost:3000/api/v1/internal/messages",
    headers: {},
    queryParams: {
      conversationId: "{{step_4['id']}}"
    },
    authType: "NONE"
  }),
  step_12: () => makeHttpSettings({
    method: "POST",
    url: "http://localhost:3000/api/v1/internal/messages",
    headers: {
      "Content-Type": "application/json"
    },
    queryParams: {},
    authType: "NONE",
    body_type: "json",
    body: {
      conversationId: "{{step_4['id']}}",
      role: "ai",
      content: "{{step_11}}"
    }
  })
};

mainAiContent.flows[0].trigger = traverseAndReplace(mainAiContent.flows[0].trigger, mainReplacements);
mainAiContent.name = "Main AI Core Flow (PostgreSQL V2 FIXED)";
mainAiContent.flows[0].displayName = "Main AI Core Flow (PostgreSQL V2 FIXED)";
fs.writeFileSync(
  path.join(fixedDir, "Main AI Core Flow (PostgreSQL V2 FIXED).json"),
  JSON.stringify(mainAiContent, null, 2)
);

// ─── 2. MCP Tool - get_ticket_status ──────────────────────
console.log("Migrating MCP Tool - get_ticket_status...");
const statusContent = readJsonFile(path.join(nocodbDir, "MCP Tool - get_ticket_status (NocoDB).json"));

const statusReplacements: Record<string, (settings: any) => any> = {
  step_1: () => makeHttpSettings({
    method: "GET",
    url: "http://localhost:3000/api/v1/internal/tickets/status",
    headers: {},
    queryParams: {
      conversationId: "{{trigger.conversation_id}}"
    },
    authType: "NONE"
  })
};

statusContent.flows[0].trigger = traverseAndReplace(statusContent.flows[0].trigger, statusReplacements);
statusContent.name = "MCP Tool - get_ticket_status (PostgreSQL V2 FIXED)";
statusContent.flows[0].displayName = "MCP Tool - get_ticket_status (PostgreSQL V2 FIXED)";

// Also patch router firstValues and JSON output mappings to step_1.output.body[0] instead of step_1.output.list[0]
const statusStr = JSON.stringify(statusContent);
const patchedStatusStr = statusStr.replace(/step_1\.output\.list\[0\]/g, "step_1.output.body[0]");
fs.writeFileSync(
  path.join(fixedDir, "MCP Tool - get_ticket_status (PostgreSQL V2 FIXED).json"),
  patchedStatusStr
);

// ─── 3. Backend - Human Reply Flow ────────────────────────
console.log("Migrating Backend - Human Reply Flow...");
const humanReplyContent = readJsonFile(path.join(nocodbDir, "Backend - Human Reply Flow (NocoDB).json"));

const humanReplacements: Record<string, (settings: any) => any> = {
  step_1: () => makeHttpSettings({
    method: "POST",
    url: "http://localhost:3000/api/v1/internal/messages",
    headers: {
      "Content-Type": "application/json"
    },
    queryParams: {},
    authType: "NONE",
    body_type: "json",
    body: {
      conversationId: "{{trigger.body.conversation_id}}",
      role: "human",
      content: "{{trigger.body.message}}"
    }
  }),
  step_2: () => makeHttpSettings({
    method: "GET",
    url: "http://localhost:3000/api/v1/internal/conversations/details",
    headers: {},
    queryParams: {
      conversationId: "{{trigger.body.conversation_id}}"
    },
    authType: "NONE"
  }),
  step_2_2: () => makeHttpSettings({
    method: "GET",
    url: "http://localhost:3000/api/v1/internal/identities/details",
    headers: {},
    queryParams: {
      identityId: "{{step_2.output.body.identity_id}}"
    },
    authType: "NONE"
  })
};

humanReplyContent.flows[0].trigger = traverseAndReplace(humanReplyContent.flows[0].trigger, humanReplacements);
humanReplyContent.name = "Backend - Human Reply Flow (PostgreSQL V2 FIXED)";
humanReplyContent.flows[0].displayName = "Backend - Human Reply Flow (PostgreSQL V2 FIXED)";

// Also patch router and channel ref mappings from step_2_2.output.fields -> step_2_2.output.body.fields
const humanStr = JSON.stringify(humanReplyContent);
const patchedHumanStr = humanStr.replace(/step_2_2\.output\.fields/g, "step_2_2.output.body.fields");
fs.writeFileSync(
  path.join(fixedDir, "Backend - Human Reply Flow (PostgreSQL V2 FIXED).json"),
  patchedHumanStr
);

console.log("All flows migrated and fixed successfully!");
