import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// Custom Metrics
const cacheHitLatency = new Trend('edge_cache_hit_duration_ms', true);
const cacheHitSuccessRate = new Rate('edge_cache_hit_success_rate');
const totalRequests = new Counter('edge_cache_hit_requests_total');

export const options = {
  scenarios: {
    cache_hit_ramp_up: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '5s', target: 50 },   // Warm up to 50 VUs
        { duration: '10s', target: 150 }, // Ramp to 150 VUs
        { duration: '10s', target: 200 }, // Peak at 200 VUs
        { duration: '5s', target: 0 },    // Cool down
      ],
      gracefulRampDown: '2s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],              // < 1% error rate
    edge_cache_hit_duration_ms: ['p(95)<25', 'p(99)<50'], // sub-25ms p95, sub-50ms p99
    edge_cache_hit_success_rate: ['rate>0.99'],  // > 99% success
  },
};

const EDGE_URL = __ENV.EDGE_URL || 'http://localhost:3001';
const FILE_ID = __ENV.FILE_ID || 'k6-benchmark-test-file';
const VERSION = __ENV.VERSION || '1';

export default function () {
  const url = `${EDGE_URL}/edge/content/${FILE_ID}?v=${VERSION}`;
  const params = {
    headers: {
      'Accept-Encoding': 'gzip, br',
      'X-Forwarded-For': '103.21.124.1', // Simulate client IP
    },
  };


  const res = http.get(url, params);

  totalRequests.add(1);
  cacheHitLatency.add(res.timings.duration);

  const passed = check(res, {
    'status is 200 or 304': (r) => r.status === 200 || r.status === 304,
    'has X-Cache header': (r) => r.headers['X-Cache'] !== undefined || r.headers['x-cache'] !== undefined,
  });

  cacheHitSuccessRate.add(passed);
  sleep(0.05); // 50ms pacing between client requests
}
