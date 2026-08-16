import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// Custom Metrics
const uploadLatency = new Trend('upload_init_duration_ms', true);
const uploadSuccessRate = new Rate('upload_init_success_rate');
const uploadTotal = new Counter('upload_init_requests_total');

export const options = {
  scenarios: {
    upload_concurrency: {
      executor: 'ramping-vus',
      startVUs: 5,
      stages: [
        { duration: '5s', target: 20 },  // Warm up
        { duration: '10s', target: 50 }, // Ramp to 50 concurrent uploads
        { duration: '5s', target: 0 },   // Cool down
      ],
      gracefulRampDown: '2s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.02'],               // < 2% error rate
    upload_init_duration_ms: ['p(95)<80'],        // sub-80ms p95
    upload_init_success_rate: ['rate>0.98'],      // > 98% success
  },
};

const CORE_URL = __ENV.CORE_URL || 'http://localhost:3000';
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';

export default function () {
  const fileSuffix = Math.floor(Math.random() * 1000000);
  const payload = JSON.stringify({
    name: `benchmark_file_${fileSuffix}.bin`,
    mimeType: 'application/octet-stream',
    totalSize: 1048576, // 1MB
    totalChunks: 1,
    fullFileChecksum: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  });

  const params = {
    headers: {
      'Authorization': `Bearer ${AUTH_TOKEN}`,
      'Content-Type': 'application/json',
    },
  };

  const res = http.post(`${CORE_URL}/api/v1/upload/init`, payload, params);

  uploadTotal.add(1);
  uploadLatency.add(res.timings.duration);

  const passed = check(res, {
    'status is 201 or 200': (r) => r.status === 201 || r.status === 200,
    'has fileId': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.fileId !== undefined || body.id !== undefined;
      } catch (e) {
        return false;
      }
    },
  });

  uploadSuccessRate.add(passed);
  sleep(0.1);
}
