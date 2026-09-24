const axios = require('axios');

async function main() {
  try {
    const res = await axios.get('https://projects.oneweb.tech/api/v1/workspaces/cs-team/projects/95c2f51f-16c9-4048-87e2-4a28a414a979/issues/d1065af1-f400-4a4b-a6f9-8ce04be83b60/', {
      headers: {
        'X-API-Key': 'plane_api_08c97a9323bf4854b6bae958d7577f60'
      }
    });
    console.log('Plane issue found:', res.data);
  } catch (err) {
    console.error('Plane error:', err.response?.status, err.response?.data || err.message);
  }
}

main();
