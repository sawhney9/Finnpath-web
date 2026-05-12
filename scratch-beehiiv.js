require('dotenv').config();
const PUBLICATION_ID = 'pub_5caff2cc-3591-49a4-80b4-4707255b2f7b';
const API_BASE = 'https://api.beehiiv.com/v2';
const API_KEY = process.env.BEEHIIV_API_KEY;

const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` };

async function run() {
  let res = await fetch(`${API_BASE}/publications/${PUBLICATION_ID}`, { headers });
  console.log("PUB:", await res.json());

  res = await fetch(`${API_BASE}/publications/${PUBLICATION_ID}/posts?limit=1`, { headers });
  console.log("POSTS:", await res.json());
}
run();
