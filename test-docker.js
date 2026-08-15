const http = require('http');

function checkEndpoint(name, url, expectedStatus = [200, 404]) {
  return new Promise((resolve) => {
    console.log(`Testing ${name} at ${url}...`);
    const req = http.get(url, (res) => {
      if (expectedStatus.includes(res.statusCode)) {
        console.log(`✅ [PASS] ${name} is running! (Status: ${res.statusCode})`);
        resolve(true);
      } else {
        console.log(`❌ [FAIL] ${name} returned unexpected status: ${res.statusCode}`);
        resolve(false);
      }
    });

    req.on('error', (err) => {
      console.log(`❌ [FAIL] ${name} is not reachable. Is the Docker container running?`);
      console.log(`   Error: ${err.message}`);
      resolve(false);
    });
    
    req.setTimeout(2000, () => {
      console.log(`❌ [FAIL] ${name} connection timed out.`);
      req.abort();
      resolve(false);
    });
  });
}

async function runTests() {
  console.log('====================================');
  console.log('   Pravah CDN Docker Status Check   ');
  console.log('====================================\n');

  // 1. Check Core Health
  // Core has a /api/v1/health endpoint
  const coreResult = await checkEndpoint('Core Server', 'http://localhost:3000/api/v1/health', [200]);

  // 2. Check Edge Health
  // Edge doesn't have a /health route, but it should return 404 from NestJS if running
  const edgeResult = await checkEndpoint('Edge Server', 'http://localhost:3001/', [404]);

  console.log('\n====================================');
  if (coreResult && edgeResult) {
    console.log('🎉 All Docker containers are running perfectly!');
    console.log('   You are ready for AWS deployment!');
  } else {
    console.log('⚠️ Some containers are not reachable.');
    console.log('   Run "docker compose --profile core up -d" and');
    console.log('   "docker compose --profile edge up -d" to start them.');
  }
  console.log('====================================');
}

runTests();
