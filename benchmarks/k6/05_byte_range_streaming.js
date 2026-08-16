import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// Custom Metrics
const rangeLatency = new Trend('byte_range_duration_ms', true);
const rangeSuccessRate = new Rate('byte_range_success_rate');
const rangeTotal = new Counter('byte_range_requests_total');

export const options = {
  scenarios: {
    byte_range_streaming: {
      executor: 'ramping-vus',
      startVUs: 5,
      stages: [
        { duration: '5s', target: 25 },  // Warm up
        { duration: '10s', target: 50 }, // 50 concurrent partial streams
        { duration: '5s', target: 0 },   // Cool down
      ],
      gracefulRampDown: '2s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.02'],            // < 2% error rate
    byte_range_duration_ms: ['p(95)<150'],      // sub-150ms p95
    byte_range_success_rate: ['rate>0.98'],    // > 98% success
  },
};

const CORE_URL = __ENV.CORE_URL || 'http://localhost:3000';
const FILE_ID = __ENV.FILE_ID || 'k6-benchmark-test-file';
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';

const RANGES = [
  'bytes=0-1023',
  'bytes=1024-2047',
  'bytes=2048-4095',
  'bytes=4096-8191',
];

export default function () {
  const randomRange = RANGES[Math.floor(Math.random() * RANGES.length)];
  const url = `${CORE_URL}/api/v1/download/${FILE_ID}`;

  const params = {
    headers: {
      'Authorization': `Bearer ${AUTH_TOKEN}`,
      'Range': randomRange,
    },
  };

  const res = http.get(url, params);

  rangeTotal.add(1);
  rangeLatency.add(res.timings.duration);

  const passed = check(res, {
    'status is 206 or 200': (r) => r.status === 206 || r.status === 200,
    'has Content-Range or Accept-Ranges': (r) =>
      r.headers['Content-Range'] !== undefined ||
      r.headers['content-range'] !== undefined ||
      r.headers['Accept-Ranges'] !== undefined ||
      r.headers['accept-ranges'] !== undefined,
  });

  rangeSuccessRate.add(passed);
  sleep(0.05);
}
