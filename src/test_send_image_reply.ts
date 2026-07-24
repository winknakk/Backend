import axios from "axios";

async function test() {
  console.log("=== Testing Admin Send Image Reply API ===");
  try {
    const res = await axios.post("http://localhost:3000/api/admin/conversations/11/send-image?projectId=11", {
      imageUrl: "http://localhost:3000/api/v1/media/file?key=line_media/line_img_623910534139347081_56a005991b.jpg"
    });
    console.log("Response Status:", res.status);
    console.log("Response Data:", JSON.stringify(res.data, null, 2));
  } catch (err: any) {
    console.error("Test Error:", err.response?.data || err.message);
  }
}

test();
