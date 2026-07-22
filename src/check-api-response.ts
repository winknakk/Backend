import axios from "axios";

async function testImageFetch() {
  try {
    const res = await axios.get("http://localhost:3000/api/v1/media/file?key=test_sample.png", { responseType: 'arraybuffer' });
    console.log("=== Image Proxy Status:", res.status);
    console.log("=== Content-Type:", res.headers["content-type"]);
    console.log("=== Buffer length:", res.data.length);
  } catch (err: any) {
    console.error("Image proxy failed:", err.message);
  }
}

testImageFetch();
