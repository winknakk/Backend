import fs from "fs";
import path from "path";

// A 400x300 high quality sample screenshot image encoded in base64 (A colorful UI mockup image)
// Let's create an SVG card converted or a real pretty sample image Base64!
// Here is a valid, clean SVG that can be saved as SVG or we can write a clean HTML/SVG thumbnail image,
// or a real sample JPEG/PNG of a laptop screen / dashboard mockup!

const prettyImageSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1e293b"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
    <linearGradient id="card" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#3b82f6"/>
      <stop offset="100%" stop-color="#2563eb"/>
    </linearGradient>
  </defs>
  <rect width="400" height="300" fill="url(#bg)"/>
  <!-- Top bar -->
  <rect width="400" height="36" fill="#334155"/>
  <circle cx="20" cy="18" r="5" fill="#ef4444"/>
  <circle cx="36" cy="18" r="5" fill="#f59e0b"/>
  <circle cx="52" cy="18" r="5" fill="#10b981"/>
  <text x="70" y="22" fill="#94a3b8" font-family="sans-serif" font-size="12" font-weight="bold">ChatGPT - System Error Logs</text>
  
  <!-- Content area -->
  <rect x="20" y="55" width="360" height="40" rx="8" fill="url(#card)"/>
  <text x="35" y="80" fill="#ffffff" font-family="sans-serif" font-size="13" font-weight="bold">Error 500: Server Exception in Main Core</text>

  <!-- Code snippet mock -->
  <rect x="20" y="110" width="360" height="165" rx="8" fill="#020617" stroke="#1e293b"/>
  <text x="35" y="135" fill="#38bdf8" font-family="monospace" font-size="11">const err = new Error("Failed to process request");</text>
  <text x="35" y="155" fill="#f43f5e" font-family="monospace" font-size="11">stack: "Error: Internal Server Crash at line 404"</text>
  <text x="35" y="175" fill="#a7f3d0" font-family="monospace" font-size="11"> status: 500 Internal Server Error</text>
  <text x="35" y="195" fill="#94a3b8" font-family="monospace" font-size="11"> timestamp: "2026-07-22T14:40:00Z"</text>
  
  <rect x="35" y="215" width="120" height="25" rx="5" fill="#ef4444"/>
  <text x="50" y="232" fill="#ffffff" font-family="sans-serif" font-size="10" font-weight="bold">CRITICAL SEVERITY</text>
</svg>`;

function generatePrettySampleImages() {
  const uploadsDir = path.join(process.cwd(), "uploads");
  const lineMediaDir = path.join(uploadsDir, "line_media");

  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  if (!fs.existsSync(lineMediaDir)) fs.mkdirSync(lineMediaDir, { recursive: true });

  const targets = [
    path.join(uploadsDir, "test_sample.png"),
    path.join(lineMediaDir, "line_img_57.jpg"),
    path.join(lineMediaDir, "line_img_55.jpg"),
    path.join(lineMediaDir, "line_img_59.jpg")
  ];

  for (const targetPath of targets) {
    fs.writeFileSync(targetPath, prettyImageSvg);
    console.log(`✅ Created pretty SVG image file at: ${targetPath}`);
  }
}

generatePrettySampleImages();
