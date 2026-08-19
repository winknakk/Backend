import axios from "axios";

async function check() {
  try {
    const res = await axios.get("https://squid-gray-chowtime.ngrok-free.dev/health", {
      headers: { "ngrok-skip-browser-warning": "true" }
    });
    console.log("NGROK HEALTH STATUS:", res.status, res.data);
  } catch (e: any) {
    console.log("NGROK HEALTH ERR:", e.response?.status, e.response?.data || e.message);
  }
}

check();
