import fs from "fs";
import path from "path";

// A 1x1 or valid small PNG buffer with nice visible color (blue 200x200 PNG)
// Base64 of a 200x200 blue square PNG image
const samplePngBase64 = 
  "iVBORw0KGgoAAAANSU24ErkJggg=="; // Or a valid complete PNG

// Real 200x200 solid blue PNG buffer
const pngBuffer = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAYAAACtWK6eAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAA7SURBVHhe7cExAQAAAMKg9U9tCy8gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADwGppAAAdaC3JIAAAAASUVORK5CYII=",
  "base64"
);

function generateSampleImages() {
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
    fs.writeFileSync(targetPath, pngBuffer);
    console.log(`✅ Created sample image file at: ${targetPath}`);
  }
}

generateSampleImages();
